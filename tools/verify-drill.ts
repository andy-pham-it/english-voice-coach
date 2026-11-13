// Kiểm chứng Drill đọc và ghi đúng, không gọi LLM nên chạy được offline.
// Chạy: npm run verify:drill
//
// Drill chỉ có hai việc: chọn item đã đến hạn, và đẩy hạn của item đó ra theo
// lịch. Nếu đang có item đến hạn thật thì lấy một cái ra chấm thử rồi trả lại
// nguyên trạng trong `finally`; nếu không có thì chỉ kiểm phần đọc.

import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { createDb } from '../server/db/client.js';
import { mistakes, vocab } from '../server/db/schema.js';
import { answerDrill, listDrill } from '../server/review/drill.js';
import { RELEARN_DAYS, REVIEW_LADDER_DAYS } from '../server/review/schedule.js';

const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  if (!line.includes('=')) continue;
  const i = line.indexOf('=');
  const key = line.slice(0, i).trim();
  if (key && !process.env[key]) process.env[key] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
}

const DAY = 86_400_000;
const db = createDb(process.env.DATABASE_URL!);

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1;
    console.log(`  pass  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const daysUntil = (iso: string): number => Math.round((Date.parse(iso) - Date.now()) / DAY);

async function main(): Promise<void> {
  const { items } = await listDrill(db, 12);
  check('listDrill trả về mảng', Array.isArray(items));
  check('không vượt quá limit', items.length <= 12, `nhận ${items.length}`);

  const kinds = new Set(items.map((i) => i.kind));
  check('mọi item có kind hợp lệ', [...kinds].every((k) => k === 'vocab' || k === 'mistake'));

  const sorted = items.every((it, idx) => {
    if (idx === 0) return true;
    const prev = items[idx - 1]!.nextReview ? Date.parse(items[idx - 1]!.nextReview!) : 0;
    const cur = it.nextReview ? Date.parse(it.nextReview) : 0;
    return prev <= cur;
  });
  check('sắp xếp theo hạn tăng dần (null lên đầu)', sorted);

  const allDue = items.every((it) => it.nextReview === null || Date.parse(it.nextReview) <= Date.now());
  check('không có item nào chưa tới hạn', allDue);

  const target = items[0];
  if (!target) {
    console.log('  skip  không có item đến hạn — chạy một phiên nói rồi thử lại');
  } else if (target.kind === 'vocab') {
    const [before] = await db
      .select({ streak: vocab.streak, nextReview: vocab.nextReview })
      .from(vocab)
      .where(eq(vocab.id, target.id))
      .limit(1);
    try {
      const wrong = await answerDrill(db, 'vocab', target.id, 'again');
      check('chấm sai thì hẹn lại 1 ngày', daysUntil(wrong.nextReview) === RELEARN_DAYS, wrong.nextReview);
      check('chấm sai thì đứt chuỗi', wrong.streak === 0, `streak=${wrong.streak}`);

      const right = await answerDrill(db, 'vocab', target.id, 'correct');
      check(
        'chấm đúng sau khi sai thì về bậc đầu',
        daysUntil(right.nextReview) === REVIEW_LADDER_DAYS[0],
        `${daysUntil(right.nextReview)} ngày`,
      );
      check('chấm đúng thì tăng chuỗi', right.streak === 1, `streak=${right.streak}`);
    } finally {
      if (before) await db.update(vocab).set(before).where(eq(vocab.id, target.id));
    }
  } else {
    const [before] = await db
      .select({ streak: mistakes.streak, nextReview: mistakes.nextReview, active: mistakes.active })
      .from(mistakes)
      .where(eq(mistakes.id, target.id))
      .limit(1);
    try {
      const wrong = await answerDrill(db, 'mistake', target.id, 'again');
      check('lỗi tái phát thì hẹn lại 1 ngày', daysUntil(wrong.nextReview) === RELEARN_DAYS, wrong.nextReview);
      check('lỗi tái phát thì đứt chuỗi', wrong.streak === 0, `streak=${wrong.streak}`);
    } finally {
      if (before) await db.update(mistakes).set(before).where(eq(mistakes.id, target.id));
    }
  }

  console.log(`\n${passed} pass, ${failed} fail`);
  if (failed > 0) process.exitCode = 1;
}

await main();
