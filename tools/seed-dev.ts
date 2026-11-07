// Seed dữ liệu mẫu để thử brief khi chưa có phiên thật nào.
// Chạy: npm run db:seed
// An toàn để chạy nhiều lần: dùng on conflict.

import { readFileSync } from 'node:fs';
import { createDb } from '../server/db/client.js';
import { DEFAULT_PROFILE } from '../server/memory/brief.js';
import { learnerProfile, mistakes, vocab } from '../server/db/schema.js';

function loadEnv(): void {
  const text = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
  for (const line of text.split('\n')) {
    if (!line.includes('=')) continue;
    const i = line.indexOf('=');
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim().replace(/^"|"$/g, '');
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnv();

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL missing');

const db = createDb(url);

await db
  .insert(learnerProfile)
  .values({ id: 1, contentMd: DEFAULT_PROFILE })
  .onConflictDoNothing();

const seedMistakes = [
  { pattern: 'past_tense', wrong: 'I go to the meeting yesterday', right: 'I went to the meeting yesterday', note: 'yesterday → past simple', count: 7 },
  { pattern: 'preposition', wrong: 'explain me the design', right: 'explain the design to me', note: 'explain something TO someone', count: 4 },
  { pattern: 'article', wrong: 'I reviewed pull request', right: 'I reviewed the pull request', note: 'specific request needs the', count: 3 },
];

for (const m of seedMistakes) {
  await db
    .insert(mistakes)
    .values(m)
    .onConflictDoUpdate({
      target: mistakes.pattern,
      set: { wrong: m.wrong, right: m.right, note: m.note, count: m.count },
    });
}

const seedVocab = [
  { phrase: 'push back', example: 'I pushed back on the estimate.' },
  { phrase: 'circle back', example: 'Let us circle back after lunch.' },
  { phrase: 'on my plate', example: 'I have three tasks on my plate.' },
];

for (const v of seedVocab) {
  await db.insert(vocab).values(v).onConflictDoNothing();
}

console.log('seeded: profile=1, mistakes=%d, vocab=%d', seedMistakes.length, seedVocab.length);
