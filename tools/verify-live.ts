// Kiểm chứng đường đi thật của server: brief từ DB → Live config → ephemeral
// token → WebSocket nối thẳng như client sẽ làm. Đây là bài duy nhất chứng minh
// §12 + §15 chạy được với brief thật, không phải brief giả trong spike.
//
//   GEMINI_API_KEY=... npx tsx tools/verify-live.ts
//
// Exit 0 = luồng cấp token + setup + trả lời chạy được.

import { readFileSync } from 'node:fs';
import { createDb } from '../server/db/client.js';
import { composeBrief } from '../server/memory/brief.js';
import { buildLiveConfig, clientSetup } from '../server/live/config.js';
import { createLiveToken, liveSocketUrl } from '../server/live/token.js';

const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  if (!line.includes('=')) continue;
  const i = line.indexOf('=');
  const key = line.slice(0, i).trim();
  if (!process.env[key]) process.env[key] = line.slice(i + 1).trim().replace(/^"|"$/g, '');
}

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) throw new Error('thiếu GEMINI_API_KEY (export trước khi chạy)');

const db = createDb(process.env.DATABASE_URL!);

const t0 = Date.now();
const brief = await composeBrief(db, { topic: 'a short check that the server-side brief reaches the model' });
console.log(`brief: ${brief.tokens} token, ${Date.now() - t0}ms`);

const setup = buildLiveConfig({ brief: brief.text });
const token = await createLiveToken({ apiKey, setup });
console.log(`token: ${token.name.slice(0, 24)}… (session window ${token.newSessionExpireTime})`);
if (token.name.includes(apiKey)) throw new Error('token chứa API key — không được để lộ');

const result = await new Promise<{ audioBytes: number; text: string; firstAudioMs: number | null; closeCode?: number }>(
  (resolve, reject) => {
    const ws = new WebSocket(liveSocketUrl(token.name));
    const started = Date.now();
    let audioBytes = 0;
    let text = '';
    let firstAudioMs: number | null = null;
    const timer = setTimeout(() => { ws.close(); reject(new Error('timeout 30s')); }, 30_000);

    const asText = async (d: unknown): Promise<string> =>
      typeof d === 'string' ? d : d instanceof Blob ? await d.text() : Buffer.from(d as ArrayBuffer).toString('utf8');

    ws.addEventListener('open', () => {
      // Client vẫn phải gửi setup; config thật (brief + VAD) lấy từ token.
      ws.send(JSON.stringify(clientSetup(setup.model)));
    });

    ws.addEventListener('message', async (event) => {
      let msg: any;
      try { msg = JSON.parse(await asText(event.data)); } catch { return; }

      if (msg.setupComplete) {
        ws.send(JSON.stringify({
          realtimeInput: { text: 'In one short sentence: what do you know about me and my work?' },
        }));
        return;
      }
      const sc = msg.serverContent;
      if (!sc) return;
      if (sc.modelTurn?.parts) {
        for (const p of sc.modelTurn.parts) {
          if (p.inlineData?.data) {
            audioBytes += Buffer.from(p.inlineData.data, 'base64').length;
            if (firstAudioMs === null) firstAudioMs = Date.now() - started;
          }
        }
      }
      if (sc.outputTranscription?.text) text += sc.outputTranscription.text;
      if (sc.turnComplete) {
        clearTimeout(timer);
        ws.close();
      }
    });

    ws.addEventListener('close', (e) => {
      clearTimeout(timer);
      resolve({ audioBytes, text: text.trim(), firstAudioMs, closeCode: (e as CloseEvent).code });
    });
    ws.addEventListener('error', (e) => { clearTimeout(timer); reject(new Error('ws error: ' + String((e as any)?.message ?? e))); });
  },
);

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

check('nhận setupComplete', result.audioBytes > 0 || result.text.length > 0);
check('có audio trả về', result.audioBytes > 1000, `${result.audioBytes} bytes`);
check('có transcript', result.text.length > 0, JSON.stringify(result.text.slice(0, 120)));
check('đóng sạch (1000)', result.closeCode === 1000, String(result.closeCode));
console.log(`firstAudio: ${result.firstAudioMs}ms (đo qua Node + mạng, không phải số latency của app)`);

console.log(failures === 0 ? '\nOK' : `\n${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);
