// Kiểm chứng cờ "đóng có chủ đích" của LiveSession — thứ quyết định app có tự
// nối lại khi Google cắt socket giữa phiên hay không.
//
//   npx tsx tools/verify-live-close.ts
//
// Không cần mạng, không cần mic: giả lập WebSocket, chỉ kiểm tra onClose() được
// báo đúng intentional true/false ở ba tình huống: rớt ngang, tự kết thúc, và
// reconnect (socket cũ đóng sau khi socket mới đã mở).

import { LiveSession } from '../src/live.js';

class FakeWs {
  static all: FakeWs[] = [];
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number; reason?: string }) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 1;
  closing?: boolean;
  sent: string[] = [];

  constructor(public url: string) {
    FakeWs.all.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
    const ev = { code: 1000, reason: '' };
    setImmediate(() => this.onclose?.(ev));
  }

  /** Socket bị phía server cắt ngang (1006 = abnormal). */
  drop() {
    this.readyState = 3;
    this.onclose?.({ code: 1006 });
  }
}

(globalThis as any).WebSocket = FakeWs;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

const makeSession = () => {
  const closes: { intentional: boolean; reason: string }[] = [];
  const session = new LiveSession({
    onStatus: () => undefined,
    onUserText: () => undefined,
    onAiText: () => undefined,
    onInterrupted: () => undefined,
    onUsage: () => undefined,
    onClose: (intentional, reason) => closes.push({ intentional, reason }),
  });
  return { session, closes };
};

// A. Rớt ngang giữa phiên → phải báo intentional = false để UI nối lại.
{
  FakeWs.all = [];
  const { session, closes } = makeSession();
  session.setDuplex(true);
  session.connect('ws://fake/a', 'model');
  FakeWs.all.at(-1)!.drop();
  check('rớt ngang → intentional=false', closes.length === 1 && closes[0]?.intentional === false, JSON.stringify(closes));
}

// B. Người dùng bấm Kết thúc → intentional = true, UI không được nối lại.
{
  FakeWs.all = [];
  const { session, closes } = makeSession();
  session.connect('ws://fake/b', 'model');
  session.disconnect();
  await sleep(5);
  check('tự kết thúc → intentional=true', closes.length === 1 && closes[0]?.intentional === true, JSON.stringify(closes));
}

// C. reconnect (đổi brief / nối lại): socket cũ đóng muộn hơn socket mới nên
//    phải bị coi là chủ đích, nếu không app sẽ tự nối lại vô hạn.
{
  FakeWs.all = [];
  const { session, closes } = makeSession();
  session.connect('ws://fake/c1', 'model');
  const first = FakeWs.all.at(-1)!;
  session.reconnect('ws://fake/c2', 'model');
  await sleep(5);
  const second = FakeWs.all.at(-1)!;
  check('reconnect mở socket mới', second.url === 'ws://fake/c2' && second !== first, second.url);
  check(
    'socket cũ bị coi là đóng chủ đích',
    closes.length === 1 && closes[0]?.intentional === true,
    JSON.stringify(closes),
  );

  // Socket mới vẫn phải báo rớt ngang bình thường.
  second.drop();
  check(
    'socket mới rớt ngang vẫn báo intentional=false',
    closes.length === 2 && closes[1]?.intentional === false,
    JSON.stringify(closes),
  );
}

// D. PTT: rớt đúng lúc đang giữ nút thì sau reconnect mic phải đóng lại.
{
  FakeWs.all = [];
  const { session } = makeSession();
  session.setDuplex(false);
  session.connect('ws://fake/d1', 'model');
  session.startTalking();
  session.reconnect('ws://fake/d2', 'model');
  const muted = (session as any).muted as boolean;
  check('PTT reconnect → mic đóng lại', muted === true, `muted=${muted}`);
}

// E. Live API gửi JSON trong frame nhị phân. Bỏ qua frame nhị phân là mất
//    setupComplete → không xin quyền micro, phiên treo ở "đang kết nối".
{
  FakeWs.all = [];
  const statuses: string[] = [];
  const heard: string[] = [];
  const session = new LiveSession({
    onStatus: (s) => statuses.push(s),
    onUserText: (t) => heard.push(t),
    onAiText: () => undefined,
    onInterrupted: () => undefined,
    onUsage: () => undefined,
  });
  session.connect('ws://fake/e', 'model');
  const ws = FakeWs.all.at(-1)!;
  const frame = (obj: unknown) => new TextEncoder().encode(JSON.stringify(obj)).buffer;

  check('client yêu cầu frame nhị phân dạng arraybuffer', (ws as any).binaryType === 'arraybuffer', String((ws as any).binaryType));

  ws.onmessage?.({ data: frame({ serverContent: { inputTranscription: { text: 'hello from binary' } } }) } as any);
  check('đọc được frame nhị phân', heard[0] === 'hello from binary', JSON.stringify(heard));

  ws.onmessage?.({ data: frame({ setupComplete: {} }) } as any);
  check('setupComplete trong frame nhị phân → ready', statuses.includes('ready'), JSON.stringify(statuses));
}

console.log(failures ? `\n${failures} FAIL` : '\nOK');
if (failures) process.exitCode = 1;
