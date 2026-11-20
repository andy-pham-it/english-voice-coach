// Nạp dữ liệu cho blueprint 4 tuần: profile (Context tab) + 25 cụm từ B1+
// và xếp lịch giới thiệu từng cụm bằng `next_review`.
//
// Chạy: npm run db:seed:plan            — chỉ thêm cụm từ (idempotent)
//       npm run db:seed:plan -- --profile  — ghi đè profile trong learner_profile
//
// Vì sao phải xếp lịch: brief chỉ chọn 5 cụm "đến hạn", và `deriveTopic` lấy
// cụm đến hạn đầu tiên làm chủ đề phiên. Nạp cả 25 cụm cùng lúc thì mọi phiên
// đều thành "work conversation that naturally uses …" và phần xoay vòng chủ đề
// (có "a job interview conversation") không bao giờ chạy.
//
// Vì sao có --profile: ngân sách profile trong brief là 250 token (~1.000 ký
// tự). Dài hơn sẽ bị cắt âm thầm, nên script chặn trước khi ghi.

import { readFileSync } from 'node:fs';
import { inArray } from 'drizzle-orm';
import { createDb } from '../server/db/client.js';
import { estimateTokens } from '../server/memory/brief.js';
import { learnerProfile, mistakes, vocab } from '../server/db/schema.js';

const PROFILE_TOKEN_BUDGET = 250;
const DAY_MS = 86_400_000;

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

interface PlanPhrase {
  phrase: string;
  example: string;
  dueInDays: number;
}

interface Plan {
  profile: string;
  phrases: PlanPhrase[];
}

loadEnv();

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL missing');

const raw = readFileSync(new URL('./data/interview-plan.json', import.meta.url), 'utf8');
const plan = JSON.parse(raw) as Plan;
const writeProfile = process.argv.includes('--profile');

const profileTokens = estimateTokens(plan.profile);
if (profileTokens > PROFILE_TOKEN_BUDGET) {
  throw new Error(
    `profile là ${profileTokens} token, vượt ngân sách ${PROFILE_TOKEN_BUDGET} của brief — sẽ bị cắt âm thầm. Rút ngắn trước khi nạp.`,
  );
}

const db = createDb(url);
const now = Date.now();

// Dữ liệu mẫu của `db:seed` (tools/seed-dev.ts) không phải lỗi thật của người
// học. Nếu để lại, mọi phiên đều mở đầu bằng "work conversation that naturally
// uses the phrase "push back"" (cụm này blueprint còn cấm dùng) và coach sẽ đi
// săn lỗi past_tense giả. Chỉ xoá khi được yêu cầu rõ.
const DEMO_PHRASES = ['push back', 'circle back', 'on my plate'];
const DEMO_MISTAKE_TEXTS = [
  'I go to the meeting yesterday',
  'explain me the design',
  'I reviewed pull request',
];

if (process.argv.includes('--clean-demo')) {
  const goneVocab = await db
    .delete(vocab)
    .where(inArray(vocab.phrase, DEMO_PHRASES))
    .returning({ phrase: vocab.phrase });
  const goneMistakes = await db
    .delete(mistakes)
    .where(inArray(mistakes.wrong, DEMO_MISTAKE_TEXTS))
    .returning({ pattern: mistakes.pattern });
  console.log(
    `clean-demo: xoá ${goneVocab.length} cụm mẫu (${goneVocab.map((v) => v.phrase).join(', ') || 'không có'}), ` +
      `${goneMistakes.length} lỗi mẫu (${goneMistakes.map((m) => m.pattern).join(', ') || 'không có'})`,
  );
}

if (writeProfile) {
  await db
    .insert(learnerProfile)
    .values({ id: 1, contentMd: plan.profile })
    .onConflictDoUpdate({ target: learnerProfile.id, set: { contentMd: plan.profile, updatedAt: new Date() } });
  console.log(`profile: đã ghi (${profileTokens}/${PROFILE_TOKEN_BUDGET} token)`);
} else {
  console.log(`profile: bỏ qua (${profileTokens}/${PROFILE_TOKEN_BUDGET} token) — thêm --profile để ghi đè`);
}

let inserted = 0;
for (const item of plan.phrases) {
  const nextReview = new Date(now + item.dueInDays * DAY_MS);
  const rows = await db
    .insert(vocab)
    .values({ phrase: item.phrase, example: item.example, nextReview })
    .onConflictDoNothing()
    .returning({ id: vocab.id });
  inserted += rows.length;
}

const total = await db.select({ id: vocab.id }).from(vocab);
console.log(`vocab: thêm ${inserted} cụm mới, tổng ${total.length} cụm trong DB`);
console.log('kiểm tra brief: npm run verify:brief');
