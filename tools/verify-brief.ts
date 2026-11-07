// Kiểm chứng brief builder: metric token, thứ tự phần, và ngân sách 1.000 token.
// Chạy: npm run verify:brief   (sau khi npm run db:seed)

import { readFileSync } from 'node:fs';
import { createDb } from '../server/db/client.js';
import { BRIEF_BUDGET, SECTION_BUDGET, composeBrief, estimateTokens, clipToTokens } from '../server/memory/brief.js';

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

// Unit: clipToTokens không được vượt ngân sách và phải cắt ở ranh giới từ.
const long = 'word '.repeat(400);
const clipped = clipToTokens(long, 50);
check('clipToTokens ≤ 50 token', estimateTokens(clipped) <= 50, `${estimateTokens(clipped)} token`);
check('clipToTokens giữ nguyên khi ngắn', clipToTokens('short text', 50) === 'short text');

// Integration: brief thật từ DB.
const brief = await composeBrief(createDb(process.env.DATABASE_URL!));
console.log('\n--- brief ---\n' + brief.text + '\n-------------');
console.log(`tokens: ${brief.tokens} / ${BRIEF_BUDGET} (ước lượng 4 ký tự/token)\n`);

check('brief ≤ 1.000 token', brief.tokens <= BRIEF_BUDGET, `${brief.tokens}`);
check('có <rules>', brief.text.includes('<rules>'));
check('có <profile>', brief.text.includes('<profile>'));
check('có <state>', brief.text.includes('<state>'));
check('có <today>', brief.text.includes('<today>'));
check('state nêu lỗi lặp có count', /\(\d+x, last \d{4}-\d{2}-\d{2}\)/.test(brief.text));
check('state nêu cụm từ đến hạn', brief.text.includes('Due for review:'));

// Thứ tự phần phải cố định: rules trước profile, today cuối.
const order = ['<rules>', '<profile>', '<state>', '<recall>', '<today>'].map((t) => brief.text.indexOf(t));
const present = order.filter((i) => i >= 0);
check('thứ tự phần đúng', present.every((v, i) => i === 0 || v > present[i - 1]!));

// Ngân sách cộng lại phải bằng tổng.
const sum = Object.values(SECTION_BUDGET).reduce((a, b) => a + b, 0);
check('ngân sách các phần cộng đúng', sum <= BRIEF_BUDGET, `${sum} / ${BRIEF_BUDGET}`);

console.log(failures === 0 ? '\nOK' : `\n${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);
