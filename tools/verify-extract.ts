// Kiểm chứng bước trích xuất sau phiên: gọi LLM thật, validate schema, ghi DB,
// rồi đọc lại. Chạy: npm run verify:extract
//
// Script tự tạo một session giả, chạy trọn luồng, in kết quả, và dọn sạch dữ
// liệu test trong `finally` — kể cả khi LLM fail giữa chừng — để không làm
// nhiễm branch production.

import { readFileSync } from 'node:fs';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { createDb } from '../server/db/client.js';
import { mistakes, sessions, turns, usageDaily, vocab } from '../server/db/schema.js';
import { extractAndStore, applyExtraction } from '../server/extract/run.js';
import { extractionSchema } from '../server/extract/schema.js';
import { dueVocabQuery } from '../server/memory/brief.js';

const text = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of text.split('\n')) {
  if (!line.includes('=')) continue;
  const i = line.indexOf('=');
  const key = line.slice(0, i).trim();
  if (!process.env[key]) process.env[key] = line.slice(i + 1).trim().replace(/^"|"$/g, '');
}

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

const db = createDb(process.env.DATABASE_URL!);

let sessionId: number | null = null;
const beforeMistakes = new Map<string, number>();
const beforeVocab = new Map<string, number>();
const today = new Date().toISOString().slice(0, 10);
let beforeUsage: { audioSec: number; tokens: number; requests: number } | null = null;
let usageRowExisted = false;

/** Chụp counts trước khi chạy để cuối bài khôi phục đúng số cũ, không đoán +1. */
async function snapshot() {
  for (const r of await db.select({ pattern: mistakes.pattern, count: mistakes.count }).from(mistakes)) {
    beforeMistakes.set(r.pattern, r.count);
  }
  for (const r of await db.select({ phrase: vocab.phrase, count: vocab.count }).from(vocab)) {
    beforeVocab.set(r.phrase, r.count);
  }
  const [u] = await db
    .select({ audioSec: usageDaily.liveAudioSec, tokens: usageDaily.extractTokens, requests: usageDaily.extractRequests })
    .from(usageDaily)
    .where(eq(usageDaily.day, today));
  usageRowExisted = !!u;
  beforeUsage = u ?? { audioSec: 0, tokens: 0, requests: 0 };
}

async function cleanup() {
  if (sessionId !== null) {
    await db.delete(turns).where(eq(turns.sessionId, sessionId));
    await db.delete(sessions).where(eq(sessions.id, sessionId));
  }
  // Một pattern có thể được upsert nhiều lần trong cùng một phiên (2 lỗi cùng
  // loại), nên trừ 1 là sai. Khôi phục về đúng giá trị đã chụp.
  for (const r of await db.select({ pattern: mistakes.pattern, count: mistakes.count }).from(mistakes)) {
    const before = beforeMistakes.get(r.pattern);
    if (before === undefined) {
      await db.delete(mistakes).where(eq(mistakes.pattern, r.pattern));
    } else if (r.count !== before) {
      await db.update(mistakes).set({ count: before }).where(eq(mistakes.pattern, r.pattern));
    }
  }
  for (const r of await db.select({ phrase: vocab.phrase, count: vocab.count }).from(vocab)) {
    const before = beforeVocab.get(r.phrase);
    if (before === undefined) {
      await db.delete(vocab).where(eq(vocab.phrase, r.phrase));
    } else if (r.count !== before) {
      await db.update(vocab).set({ count: before }).where(eq(vocab.phrase, r.phrase));
    }
  }
  // usage_daily không được cộng dồn qua các lần chạy verify.
  if (beforeUsage) {
    if (usageRowExisted) {
      await db
        .update(usageDaily)
        .set({ liveAudioSec: beforeUsage.audioSec, extractTokens: beforeUsage.tokens, extractRequests: beforeUsage.requests })
        .where(eq(usageDaily.day, today));
    } else {
      await db.delete(usageDaily).where(eq(usageDaily.day, today));
    }
  }
  console.log(`cleaned up session ${sessionId ?? '(none)'}`);
}

await snapshot();

try {
  // --- Hợp đồng schema: câu tomorrow dài (≤120) phải dùng lại được trong
  // used_phrases. Trước đây used_phrases max 80 nên một câu 118 ký tự làm
  // safeParse reject cả payload — mất summary, corrections, tomorrow.
  const longSentence =
    'Yesterday I went through the migration plan with the platform team and we agreed to split the rollout into two steps.';
  check(
    'used_phrases nhận câu dài như câu tomorrow',
    extractionSchema.safeParse({
      topic: 'migration planning',
      summary: 'The learner walked through a migration plan and the team agreed on two rollout steps.',
      used_phrases: [longSentence],
    }).success,
    `${longSentence.length} ký tự`,
  );

  // --- Fixture: một phiên ngắn có đúng 4 lỗi rõ ràng -----------------------
  const startedAt = new Date(Date.now() - 10 * 60_000);
  const [session] = await db
    .insert(sessions)
    .values({
      startedAt,
      endedAt: new Date(),
      durationSec: 600,
      mode: 'duplex',
      status: 'ended',
      topic: 'verify extract: sprint planning and a blocked migration',
      liveModel: 'models/gemini-3.8-live',
      briefTokens: 400,
      brief: 'fixture',
    })
    .returning({ id: sessions.id });
  const sid = session!.id;
  sessionId = sid;
  console.log(`fixture session ${sessionId}`);

  const script: { role: 'user' | 'assistant'; text: string }[] = [
    { role: 'assistant', text: 'How was your week? What did you work on?' },
    {
      role: 'user',
      text: 'Yesterday I go to the planning meeting with the platform team. We discuss about the migration for forty minutes.',
    },
    { role: 'assistant', text: 'Nice. Did you agree on a plan?' },
    {
      role: 'user',
      text: "He don't want to block the release, so we split the migration into two steps. I have 4 years experience with this kind of rollout.",
    },
    { role: 'assistant', text: 'That sounds reasonable. What is the risk?' },
    {
      role: 'user',
      text: 'The main bottleneck is the read path. If it breaks, we need to roll back fast, and I will mitigate the impact by routing traffic to the old cluster.',
    },
    { role: 'assistant', text: 'Good. Anything you would do differently?' },
    {
      role: 'user',
      text: 'I would explain me the plan to the on-call engineer earlier, because the tradeoff was not obvious to them.',
    },
  ];

  await db.insert(turns).values(
    script.map((t, i) => ({
      sessionId: sid,
      role: t.role,
      text: t.text,
      createdAt: new Date(startedAt.getTime() + i * 60_000),
    })),
  );

  // --- Chạy trích xuất thật ------------------------------------------------
  const t0 = Date.now();
  const result = await extractAndStore(db, sessionId);
  console.log(
    `extract: ${result.provider}/${result.model} ${Date.now() - t0}ms, ${result.tokens} token, ` +
      `${result.corrections} correction, ${result.phrases} phrase, ${result.turnsMatched} turn gắn correction`,
  );

  const [after] = await db
    .select({
      topic: sessions.topic,
      summary: sessions.summary,
      status: sessions.status,
      endedAt: sessions.endedAt,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);

  console.log('\n--- topic ---\n' + (after?.topic ?? '(null)'));
  console.log('--- summary ---\n' + (after?.summary ?? '(null)') + '\n-------------');

  check('session có topic', !!after?.topic && after.topic.length > 3);
  check('session có summary', !!after?.summary && after.summary.length > 20);
  check('session status=ended', after?.status === 'ended');
  check('corrections > 0', result.corrections > 0, `${result.corrections}`);
  check('corrections ≤ 5', result.corrections <= 5);

  // Fixture có lỗi thật nên phải sinh được câu dùng ngay mai; "0 câu" là
  // trạng thái chưa có tính năng, không phải trạng thái đúng.
  const tomorrow = result.extraction.tomorrow ?? [];
  check('tomorrow 1–3 câu', tomorrow.length >= 1 && tomorrow.length <= 3, `${tomorrow.length}`);
  check(
    'mỗi câu tomorrow có en + vi + tag',
    tomorrow.every((t) => t.en.length >= 8 && t.vi.length >= 4 && !!t.tag),
  );

  const written = await db
    .select({ pattern: mistakes.pattern, wrong: mistakes.wrong, right: mistakes.right, count: mistakes.count })
    .from(mistakes)
    .where(
      inArray(mistakes.pattern, [
        'past_tense',
        'preposition',
        'third_person_s',
        'subject_verb_agreement',
        'verb_pattern',
      ]),
    );
  check(
    'ghi được mistakes theo pattern',
    written.length > 0,
    written.map((w) => `${w.pattern}×${w.count}`).join(', '),
  );

  const withCorrection = await db
    .select({ id: turns.id, corrections: turns.corrections })
    .from(turns)
    .where(and(eq(turns.sessionId, sessionId), sql`${turns.corrections} is not null`));
  check('gắn correction vào turn của người học', withCorrection.length > 0, `${withCorrection.length} turn`);

  const vocabRows = await db
    .select({ phrase: vocab.phrase, count: vocab.count, createdAt: vocab.createdAt })
    .from(vocab);
  const newVocab = vocabRows.filter((v) => v.createdAt.getTime() >= t0);
  console.log('vocab mới trong phiên:', newVocab.map((v) => `${v.phrase}×${v.count}`).join(', ') || '(không có)');

  const tomorrowRows = await db
    .select({ tomorrow: sessions.tomorrow })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  check(
    'tomorrow được lưu vào session',
    (tomorrowRows[0]?.tomorrow ?? []).length === tomorrow.length,
    `${(tomorrowRows[0]?.tomorrow ?? []).length}/${tomorrow.length}`,
  );
  const tomorrowInVocab = vocabRows.filter((v) => tomorrow.some((t) => t.en === v.phrase));
  check(
    'câu tomorrow vào vocab',
    tomorrowInVocab.length === tomorrow.length,
    `${tomorrowInVocab.length}/${tomorrow.length}`,
  );

  // Câu của hôm nay phải thắng tie count=1 với 3 cụm seed khi sang ngày mai,
  // nếu không brief phiên sau cắt mất đúng những câu vừa dạy.
  await db
    .update(vocab)
    .set({ nextReview: new Date(Date.now() - 86_400_000) })
    .where(inArray(vocab.phrase, tomorrow.map((t) => t.en)));
  const dueNow = await dueVocabQuery(db, 3);
  check(
    'câu tomorrow vào danh sách đến hạn của brief',
    tomorrow.every((t) => dueNow.some((d) => d.phrase === t.en)),
    dueNow.map((d) => d.phrase).join(' | '),
  );

  // --- Test tất định cho used_phrases + hạn ôn, không phụ thuộc LLM --------
  const [second] = await db
    .insert(sessions)
    .values({
      startedAt: new Date(Date.now() - 60_000),
      status: 'ended',
      durationSec: 60,
      mode: 'duplex',
      brief: 'fixture 2',
      briefTokens: 10,
    })
    .returning({ id: sessions.id });
  const sid2 = second!.id;
  const fixtureTomorrow = {
    en: 'I will follow up on the read path tomorrow morning.',
    vi: 'Mai tôi sẽ theo tiếp phần read path.',
    tag: 'standup' as const,
  };
  const pushBefore = await db
    .select({ count: vocab.count, nextReview: vocab.nextReview })
    .from(vocab)
    .where(eq(vocab.phrase, 'push back'));
  const fixtureExtraction = {
    topic: 'follow up on the read path',
    summary: 'Short fixture session used to check the vocabulary review dates.',
    corrections: [],
    new_phrases: [],
    tomorrow: [fixtureTomorrow],
    used_phrases: ['push back'],
  };
  await applyExtraction(db, sid2, fixtureExtraction, { provider: 'test', model: 'test', tokens: 0 });
  const runOnce = await db.select().from(vocab).where(eq(vocab.phrase, 'push back'));
  const credited = (runOnce[0]?.count ?? 0) - (pushBefore[0]?.count ?? 0);
  const creditedDays = runOnce[0]?.nextReview
    ? Math.round((runOnce[0].nextReview.getTime() - Date.now()) / 86_400_000)
    : null;
  check('cụm đã dùng được cộng đúng 1', credited === 1, `${credited}`);
  check('cụm đã dùng hẹn ôn sau ~7 ngày', creditedDays !== null && creditedDays >= 6 && creditedDays <= 8, `${creditedDays} ngày`);

  const fixtureRow = await db.select().from(vocab).where(eq(vocab.phrase, fixtureTomorrow.en));
  const fixtureDays = fixtureRow[0]?.nextReview
    ? Math.round((fixtureRow[0].nextReview.getTime() - Date.now()) / 86_400_000)
    : null;
  check(
    'câu tomorrow hẹn ôn sau ~1 ngày',
    fixtureRow.length === 1 && fixtureDays !== null && fixtureDays >= 0 && fixtureDays <= 2,
    `${fixtureDays} ngày`,
  );

  await applyExtraction(db, sid2, fixtureExtraction, { provider: 'test', model: 'test', tokens: 0 });
  const runTwice = await db.select().from(vocab).where(eq(vocab.phrase, 'push back'));
  check('ghi lại không cộng lần hai', runTwice[0]?.count === runOnce[0]?.count, `${runTwice[0]?.count}`);
  await db.delete(sessions).where(eq(sessions.id, sid2));

  // Idempotent: gọi lại không được cộng count lần hai.
  const before = await db
    .select({ count: mistakes.count })
    .from(mistakes)
    .where(eq(mistakes.pattern, 'past_tense'));
  const again = await applyExtraction(
    db,
    sessionId,
    {
      topic: 'x',
      summary: 'y',
      corrections: [{ pattern: 'past_tense', wrong: 'a', right: 'b', note: '' }],
      new_phrases: [],
      tomorrow: [],
      used_phrases: [],
    },
    { provider: 'test', model: 'test', tokens: 0 },
  );
  const afterCount = await db
    .select({ count: mistakes.count })
    .from(mistakes)
    .where(eq(mistakes.pattern, 'past_tense'));
  check('gọi lại không ghi đè (idempotent)', again.corrections === 0 && afterCount[0]?.count === before[0]?.count);

  const [usage] = await db
    .select({ tokens: usageDaily.extractTokens, requests: usageDaily.extractRequests })
    .from(usageDaily)
    .where(eq(usageDaily.day, new Date().toISOString().slice(0, 10)));
  check('usage_daily ghi nhận call trích xuất', (usage?.requests ?? 0) > 0, `${usage?.tokens} token, ${usage?.requests} call`);
} catch (err) {
  check('chạy trọn bước trích xuất', false, err instanceof Error ? err.message.slice(0, 200) : String(err));
} finally {
  await cleanup();
}

console.log(failures ? `\n${failures} FAIL` : '\nOK');
process.exit(failures ? 1 : 0);
