// Kiểm chứng lịch ôn ghi đúng vào DB, không gọi LLM nên chạy được offline.
// Chạy: npm run verify:schedule
//
// Ba thứ được kiểm: cụm dùng đúng thì leo bậc, lỗi tái phát thì đứt chuỗi và
// hẹn lại 1 ngày, lỗi cũ được sửa thì cũng leo bậc. Mọi thay đổi đều được trả
// lại nguyên trạng trong `finally`.

import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { createDb } from '../server/db/client.js';
import { mistakes, sessions, vocab } from '../server/db/schema.js';
import { applyExtraction } from '../server/extract/run.js';
import { REVIEW_LADDER_DAYS } from '../server/review/schedule.js';

const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  if (!line.includes('=')) continue;
  const i = line.indexOf('=');
  const key = line.slice(0, i).trim();
  if (key && !process.env[key]) process.env[key] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
}

const DAY = 86_400_000;
const db = createDb(process.env.DATABASE_URL!);
const phrase = `__sched_probe_${Date.now()}`;
const pattern = 'past_tense';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

function daysTo(d: Date | null): number | null {
  return d ? Math.round((d.getTime() - Date.now()) / DAY) : null;
}

const sessionIds: number[] = [];

async function newSession(brief: string): Promise<number> {
  const [row] = await db
    .insert(sessions)
    .values({ startedAt: new Date(), status: 'ended', durationSec: 60, mode: 'duplex', brief, briefTokens: 1 })
    .returning({ id: sessions.id });
  sessionIds.push(row!.id);
  return row!.id;
}

const before = await db.select().from(mistakes).where(eq(mistakes.pattern, pattern)).limit(1);
const hadPattern = before.length > 0;

try {
  // --- cụm từ đã dùng đúng: streak 1 → 2, hạn nhảy lên bậc 7 ngày ------------
  await db.insert(vocab).values({ phrase, count: 2, streak: 1, nextReview: new Date(Date.now() - DAY) });
  const s1 = await newSession('probe: used_phrases');
  await applyExtraction(
    db,
    s1,
    { topic: 'probe', summary: 'probe', corrections: [], new_phrases: [], tomorrow: [], used_phrases: [phrase], fixed_patterns: [] },
    { provider: 'test', model: 'test', tokens: 0 },
  );
  const afterUsed = (await db.select().from(vocab).where(eq(vocab.phrase, phrase)).limit(1))[0]!;
  check('cụm dùng đúng: streak 1 → 2', afterUsed.streak === 2, `streak=${afterUsed.streak}`);
  check(
    `cụm dùng đúng: hẹn ${REVIEW_LADDER_DAYS[1]} ngày`,
    daysTo(afterUsed.nextReview) === REVIEW_LADDER_DAYS[1],
    `${daysTo(afterUsed.nextReview)} ngày`,
  );

  // --- lỗi tái phát: đứt chuỗi, hẹn 1 ngày -----------------------------------
  const s2 = await newSession('probe: corrections');
  await applyExtraction(
    db,
    s2,
    {
      topic: 'probe',
      summary: 'probe',
      corrections: [{ pattern, wrong: 'I go yesterday', right: 'I went yesterday', note: 'quá khứ' }],
      new_phrases: [],
      tomorrow: [],
      used_phrases: [],
      fixed_patterns: [],
    },
    { provider: 'test', model: 'test', tokens: 0 },
  );
  const afterMiss = (await db.select().from(mistakes).where(eq(mistakes.pattern, pattern)).limit(1))[0]!;
  check('lỗi tái phát: streak về 0', afterMiss.streak === 0, `streak=${afterMiss.streak}`);
  check('lỗi tái phát: hẹn 1 ngày', daysTo(afterMiss.nextReview) === 1, `${daysTo(afterMiss.nextReview)} ngày`);

  // --- lỗi cũ được sửa: leo bậc thay vì kẹt ở 0 ------------------------------
  const s3 = await newSession('probe: fixed_patterns');
  await applyExtraction(
    db,
    s3,
    { topic: 'probe', summary: 'probe', corrections: [], new_phrases: [], tomorrow: [], used_phrases: [], fixed_patterns: [pattern] },
    { provider: 'test', model: 'test', tokens: 0 },
  );
  const afterFix = (await db.select().from(mistakes).where(eq(mistakes.pattern, pattern)).limit(1))[0]!;
  check('lỗi được sửa: streak 0 → 1', afterFix.streak === 1, `streak=${afterFix.streak}`);
  check(
    `lỗi được sửa: hẹn ${REVIEW_LADDER_DAYS[0]} ngày`,
    daysTo(afterFix.nextReview) === REVIEW_LADDER_DAYS[0],
    `${daysTo(afterFix.nextReview)} ngày`,
  );
  check('lỗi được sửa: vẫn còn được nhắc', afterFix.active === true, `active=${afterFix.active}`);
} finally {
  await db.delete(vocab).where(eq(vocab.phrase, phrase));
  for (const id of sessionIds) await db.delete(sessions).where(eq(sessions.id, id));
  if (hadPattern) {
    const b = before[0]!;
    await db
      .update(mistakes)
      .set({ streak: b.streak, nextReview: b.nextReview, active: b.active, count: b.count })
      .where(eq(mistakes.pattern, pattern));
  } else {
    await db.delete(mistakes).where(eq(mistakes.pattern, pattern));
  }
}

console.log(`\n${passed} pass, ${failed} fail`);
process.exit(failed ? 1 : 0);
