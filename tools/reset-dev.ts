#!/usr/bin/env node
// Đưa DB dev (Neon branch production, chỉ dùng cho một người) về trạng thái seed.
//   npx tsx tools/reset-dev.ts
//
// Xoá TOÀN BỘ sessions / turns / mistakes / vocab / usage_daily rồi ghi lại
// đúng 3 lỗi + 3 cụm từ mẫu. Profile giữ nguyên nếu đã có, chưa có thì ghi DEFAULT_PROFILE.

import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { createDb } from '../server/db/client.js';
import { mistakes, sessions, turns, usageDaily, vocab, learnerProfile } from '../server/db/schema.js';
import { DEFAULT_PROFILE } from '../server/memory/brief.js';

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const i = line.indexOf('=');
  if (i > 0 && !process.env[line.slice(0, i)]) {
    process.env[line.slice(0, i)] = line.slice(i + 1).trim().replace(/^"|"$/g, '');
  }
}

const db = createDb(process.env.DATABASE_URL!);

await db.delete(turns);
await db.delete(sessions);
await db.delete(mistakes);
await db.delete(vocab);
await db.delete(usageDaily);

await db.insert(mistakes).values([
  {
    pattern: 'past_tense',
    wrong: 'I go to the meeting yesterday',
    right: 'I went to the meeting yesterday',
    note: 'yesterday → quá khứ đơn',
    count: 7,
  },
  {
    pattern: 'preposition',
    wrong: 'we discuss about the migration',
    right: 'we discussed the migration',
    note: 'discuss không đi với about',
    count: 4,
  },
  {
    pattern: 'article',
    wrong: 'I reviewed pull request',
    right: 'I reviewed the pull request',
    note: 'danh từ xác định cần the',
    count: 3,
  },
]);

await db.insert(vocab).values([
  { phrase: 'push back', example: 'I pushed back on the estimate.', count: 1 },
  { phrase: 'circle back', example: "Let's circle back after standup.", count: 1 },
  { phrase: 'on my plate', example: 'I have three tickets on my plate.', count: 1 },
]);

const profile = await db.select({ id: learnerProfile.id }).from(learnerProfile).where(eq(learnerProfile.id, 1));
if (!profile.length) {
  await db.insert(learnerProfile).values({ id: 1, contentMd: DEFAULT_PROFILE });
}

const summary = {
  mistakes: (await db.select({ pattern: mistakes.pattern, count: mistakes.count }).from(mistakes)).length,
  vocab: (await db.select({ phrase: vocab.phrase }).from(vocab)).length,
  sessions: (await db.select({ id: sessions.id }).from(sessions)).length,
  usage: (await db.select({ day: usageDaily.day }).from(usageDaily)).length,
};
console.log('reset xong:', summary);
