#!/usr/bin/env node
// Verify luồng ephemeral token của Live API — thứ spec §15 giả định nhưng spike
// chưa từng kiểm chứng.
//
//   GEMINI_API_KEY=... node tools/verify-token.mjs
//
// 1. POST v1alpha/auth_tokens (header x-goog-api-key) → auth_tokens/<name>
// 2. Mở WebSocket method **BidiGenerateContentConstrained** bằng ?access_token=
// 3. Gửi setup {model} (config thật lấy từ token, client gửi gì cũng bị bỏ)
// 4. Gửi 1 câu text, đếm audio trả về + transcript
//
// Exit 0 = luồng deploy dùng được. Exit 1 = phải đổi thiết kế §15.

const KEY = process.env.GEMINI_API_KEY;
if (!KEY) {
  console.error('thiếu GEMINI_API_KEY');
  process.exit(1);
}

const MODEL = process.env.LIVE_MODEL || 'models/gemini-3.8-live';
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

const SETUP = {
  model: MODEL,
  generationConfig: { responseModalities: ['AUDIO'] },
  systemInstruction: { parts: [{ text: 'Answer in one short English sentence.' }] },
  inputAudioTranscription: {},
  outputAudioTranscription: {},
};

async function createToken() {
  // REST dùng `bidiGenerateContentSetup`; SDK gọi field này là
  // liveConnectConstraints. Token chỉ dùng được với Live API v1alpha.
  const res = await fetch('https://generativelanguage.googleapis.com/v1alpha/auth_tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY },
    body: JSON.stringify({
      uses: 1,
      expireTime: iso(now + 30 * 60 * 1000),
      newSessionExpireTime: iso(now + 2 * 60 * 1000),
      bidiGenerateContentSetup: SETUP,
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`auth_tokens ${res.status}: ${JSON.stringify(json).slice(0, 400)}`);
  return json.name;
}

const asText = async (d) => typeof d === 'string'
  ? d
  : d instanceof Blob ? await d.text() : Buffer.from(d).toString('utf8');

function runSession(tokenName) {
  return new Promise((resolve, reject) => {
    // Method phải là BidiGenerateContentConstrained. Dùng BidiGenerateContent
    // sẽ trả 1008 "Method doesn't allow unregistered callers" — đây là cái bẫy
    // tốn thời gian nhất khi tự implement bằng WebSocket thuần.
    const url = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained'
      + `?access_token=${tokenName}`;
    const ws = new WebSocket(url);
    const out = { setupComplete: false, audioBytes: 0, outputText: '', turnComplete: false, errors: [] };
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('timeout 25s — không có phản hồi')); }, 25000);
    let sentTurn = false;

    ws.onopen = () => {
      out.sentAt = Date.now();
      // Client vẫn phải gửi setup; token đã chốt config nên chỉ cần model.
      ws.send(JSON.stringify({ setup: { model: MODEL } }));
    };
    ws.onmessage = async (ev) => {
      let msg;
      try { msg = JSON.parse(await asText(ev.data)); } catch { return; }
      if (msg.setupComplete) {
        out.setupComplete = true;
        if (!sentTurn) {
          sentTurn = true;
          ws.send(JSON.stringify({ realtimeInput: { text: 'Say exactly: token path works.' } }));
        }
      }
      if (msg.serverContent) {
        const sc = msg.serverContent;
        if (sc.outputTranscription?.text) {
          out.outputText += sc.outputTranscription.text;
          if (!out.firstAudioMs) out.firstAudioMs = Date.now() - (out.sentAt || Date.now());
        }
        for (const part of sc.modelTurn?.parts || []) {
          if (part.inlineData?.data) out.audioBytes += Buffer.from(part.inlineData.data, 'base64').length;
        }
        if (sc.turnComplete) {
          out.turnComplete = true;
          clearTimeout(timer);
          ws.close();
        }
      }
      if (msg.error) out.errors.push(msg.error);
    };
    ws.onerror = (e) => out.errors.push({ ws: String(e.message || e.type) });
    ws.onclose = (e) => {
      clearTimeout(timer);
      resolve({ ...out, closeCode: e.code, closeReason: e.reason });
    };
  });
}

try {
  const name = await createToken();
  console.log('token:', name.slice(0, 28) + '…');
  const r = await runSession(name);
  console.log(JSON.stringify(r, null, 2));
  const ok = r.setupComplete && r.audioBytes > 0 && r.errors.length === 0;
  console.log(ok
    ? '\nKẾT LUẬN: ephemeral token dùng được — client không cần API key.'
    : '\nKẾT LUẬN: KHÔNG đạt, xem chi tiết trên.');
  process.exit(ok ? 0 : 1);
} catch (err) {
  console.error('FAIL:', err.message);
  process.exit(1);
}
