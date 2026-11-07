// Kiểm tra toàn bộ API surface bằng app.request — không cần bật server, không
// tốn request LLM (bước end có thể timeout vì free tier chậm; timeout là hành
// vi hợp lệ và được assert riêng).
//
//   npm run verify:api        (hoặc: npx tsx tools/verify-api.ts)

import { readFileSync } from 'node:fs';
import { createApp } from '../server/app';
import { getDb } from '../server/db';
import { mistakes, sessions, turns, usageDaily, vocab } from '../server/db/schema';
import { eq, sql } from 'drizzle-orm';

function loadEnvLocal() {
  try {
    const text = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      const key = m?.[1];
      const raw = m?.[2];
      if (!key || raw === undefined) continue;
      if (!process.env[key]) process.env[key] = raw.replace(/^"|"$/g, '');
    }
  } catch {
    // không có .env.local → dựa vào env của shell
  }
}

loadEnvLocal();
// Auth bật trong lúc verify để test được cookie, không phụ thuộc .env.local.
process.env.ACCESS_CODE = 'verify-code';
process.env.AUTH_SECRET = 'verify-secret-0123456789abcdef0123456789abcdef';
process.env.NODE_ENV = 'test';

const app = createApp();
const results: { name: string; ok: boolean; detail: string }[] = [];

function check(name: string, ok: boolean, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

async function call(path: string, init: RequestInit = {}, cookie?: string) {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('content-type', 'application/json');
  if (cookie) headers.set('cookie', cookie);
  return app.request(path, { ...init, headers });
}

function setCookieOf(res: Response): string {
  const raw = res.headers.get('set-cookie') ?? '';
  return raw.split(';')[0] ?? '';
}

const db = getDb();
let sessionId: number | null = null;
let originalProfile: string | null = null;
let audioSec = 0;

// Bước end giờ chạy trích xuất thật (Groq ~3s) nên nó ghi mistakes/vocab/usage.
// Chụp lại trước khi chạy để trả DB về đúng trạng thái — đừng trừ 1, vì một
// phiên có thể có 2 lỗi cùng pattern.
const beforeMistakes = new Map<string, number>();
const beforeVocab = new Map<string, number>();
const day = new Date().toISOString().slice(0, 10);
let beforeUsage: { audioSec: number; tokens: number; requests: number } | null = null;

for (const r of await db.select({ pattern: mistakes.pattern, count: mistakes.count }).from(mistakes)) {
  beforeMistakes.set(r.pattern, r.count);
}
for (const r of await db.select({ phrase: vocab.phrase, count: vocab.count }).from(vocab)) {
  beforeVocab.set(r.phrase, r.count);
}
{
  const [u] = await db
    .select({
      audioSec: usageDaily.liveAudioSec,
      tokens: usageDaily.extractTokens,
      requests: usageDaily.extractRequests,
    })
    .from(usageDaily)
    .where(eq(usageDaily.day, day));
  beforeUsage = u ?? null;
}

try {
  // 1. health
  const health = await call('/api/health');
  const healthBody = await health.json();
  check('health 200', health.status === 200, JSON.stringify(healthBody));

  // 2. auth: sai code → 401
  const bad = await call('/api/auth', { method: 'POST', body: JSON.stringify({ code: 'nope' }) });
  check('auth sai code → 401', bad.status === 401);

  // 3. auth: đúng code → cookie
  const login = await call('/api/auth', { method: 'POST', body: JSON.stringify({ code: 'verify-code' }) });
  const cookie = setCookieOf(login);
  check('auth đúng code → cookie', login.status === 200 && cookie.startsWith('evc_auth='), cookie.slice(0, 24));

  // 4. không cookie → 401
  const denied = await call('/api/context');
  check('thiếu cookie → 401', denied.status === 401);

  // 5. cookie → 200
  const ctxBefore = await call('/api/context', {}, cookie);
  const ctxBeforeBody = await ctxBefore.json();
  check(
    'context 200 + có profile',
    ctxBefore.status === 200 && typeof ctxBeforeBody.profile === 'string' && ctxBeforeBody.profile.length > 50,
    `mistakes=${ctxBeforeBody.mistakes?.length ?? 0}`,
  );

  originalProfile = typeof ctxBeforeBody.profile === 'string' ? ctxBeforeBody.profile : null;

  // 6. start session
  const start = await call('/api/session/start', { method: 'POST', body: JSON.stringify({ mode: 'ptt' }) }, cookie);
  const startBody = await start.json();
  sessionId = startBody?.session_id ?? null;
  check(
    'session/start 200',
    start.status === 200 && typeof sessionId === 'number' && startBody.brief_tokens > 0,
    `id=${sessionId} brief=${startBody.brief_tokens} token topic=${startBody.topic}`,
  );
  check(
    'start trả live token + socket',
    typeof startBody.live?.token === 'string' &&
      startBody.live.token.startsWith('auth_tokens/') &&
      String(startBody.live.socket).includes('BidiGenerateContentConstrained'),
    String(startBody.live?.token ?? '').slice(0, 22),
  );
  check('start trả recap', Array.isArray(startBody.recap?.mistakes), `${startBody.recap?.mistakes?.length ?? 0} lỗi`);

  // 7. resume trong 15 phút phải trả cùng session, không tạo row mới
  const resume = await call('/api/session/start', { method: 'POST', body: JSON.stringify({ mode: 'ptt' }) }, cookie);
  const resumeBody = await resume.json();
  check(
    'start lần 2 → resume cùng session',
    resume.status === 200 && resumeBody.session_id === sessionId && resumeBody.resumed === true,
  );

  // 8. events
  audioSec = 12;
  const events = await call(
    `/api/session/${sessionId}/events`,
    {
      method: 'POST',
      body: JSON.stringify({
        turns: [
          { role: 'user', text: 'Yesterday I go to the planning meeting.', audioMs: 6000 },
          { role: 'assistant', text: 'Say I went to the planning meeting. Past tense after yesterday.' },
        ],
        usage: { audioSec, tokens: 120 },
      }),
    },
    cookie,
  );
  const eventsBody = await events.json();
  check(
    'events ghi 2 turn + usage',
    events.status === 200 && eventsBody.turns === 2 && eventsBody.audioSec === audioSec,
    JSON.stringify(eventsBody),
  );

  // 9. rebrief
  const rebrief = await call(`/api/session/${sessionId}/rebrief`, { method: 'POST' }, cookie);
  const rebriefBody = await rebrief.json();
  check(
    'rebrief trả brief mới + token mới',
    rebrief.status === 200 && rebriefBody.brief_tokens > 0 && String(rebriefBody.live?.token).startsWith('auth_tokens/'),
    `brief=${rebriefBody.brief_tokens} token`,
  );

  // 10. event cho session không tồn tại → 404
  const ghost = await call(`/api/session/999999999/events`, { method: 'POST', body: JSON.stringify({ turns: [] }) }, cookie);
  check('events session lạ → 404', ghost.status === 404);

  // 11. profile
  const putProfile = await call(
    '/api/context/profile',
    { method: 'PUT', body: JSON.stringify({ contentMd: '## Who I am\nVerify run profile.' }) },
    cookie,
  );
  check('PUT profile 200', putProfile.status === 200);
  const ctxAfter = await (await call('/api/context', {}, cookie)).json();
  check('profile đã ghi', String(ctxAfter.profile).includes('Verify run profile.'));

  // 12. end — free tier có thể vượt 30s nên chấp nhận done | timeout | failed
  const end = await call(`/api/session/${sessionId}/end`, { method: 'POST', body: JSON.stringify({ durationSec: 60 }) }, cookie);
  const endBody = await end.json();
  check(
    'end đóng session + trả trạng thái extract',
    end.status === 200 && endBody.status === 'ended' && ['done', 'timeout', 'failed'].includes(endBody.extract),
    `extract=${endBody.extract}${endBody.error ? ' (' + endBody.error + ')' : ''}`,
  );

  // 13. end lần 2 → idempotent
  const end2 = await call(`/api/session/${sessionId}/end`, { method: 'POST' }, cookie);
  const end2Body = await end2.json();
  check('end lần 2 idempotent', end2.status === 200 && end2Body.alreadyEnded === true);

  // 14. mistake không tồn tại → 404
  const del = await call('/api/mistakes/999999999', { method: 'DELETE' }, cookie);
  check('xoá mistake lạ → 404', del.status === 404);
} catch (error) {
  check('không có exception', false, error instanceof Error ? error.message : String(error));
} finally {
  if (originalProfile) {
    await db.execute(sql`update learner_profile set content_md = ${originalProfile}, updated_at = now() where id = 1`);
    console.log('restored profile');
  }
  if (sessionId) {
    await db.delete(turns).where(eq(turns.sessionId, sessionId));
    await db.delete(sessions).where(eq(sessions.id, sessionId));
    console.log(`cleaned up session ${sessionId}`);
  }
  for (const r of await db.select({ pattern: mistakes.pattern, count: mistakes.count }).from(mistakes)) {
    const before = beforeMistakes.get(r.pattern);
    if (before === undefined) await db.delete(mistakes).where(eq(mistakes.pattern, r.pattern));
    else if (r.count !== before) await db.update(mistakes).set({ count: before }).where(eq(mistakes.pattern, r.pattern));
  }
  for (const r of await db.select({ phrase: vocab.phrase, count: vocab.count }).from(vocab)) {
    const before = beforeVocab.get(r.phrase);
    if (before === undefined) await db.delete(vocab).where(eq(vocab.phrase, r.phrase));
    else if (r.count !== before) await db.update(vocab).set({ count: before }).where(eq(vocab.phrase, r.phrase));
  }
  if (beforeUsage) {
    await db
      .update(usageDaily)
      .set({
        liveAudioSec: beforeUsage.audioSec,
        extractTokens: beforeUsage.tokens,
        extractRequests: beforeUsage.requests,
      })
      .where(eq(usageDaily.day, day));
  } else {
    await db.delete(usageDaily).where(eq(usageDaily.day, day));
  }
  console.log('restored mistakes/vocab/usage');
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  if (failed.length) process.exitCode = 1;
}
