// Kiểm chứng brief builder: metric token, thứ tự phần, và ngân sách 1.000 token.
// Chạy: npm run verify:brief   (sau khi npm run db:seed)

import { readFileSync } from 'node:fs';
import { eventsSchema } from '../server/app.js';
import { createDb } from '../server/db/client.js';
import {
  BRIEF_BUDGET,
  INTERVIEW_RULES,
  REFLEX_RULES,
  REASON_RULES,
  RULES,
  SECTION_BUDGET,
  composeBrief,
  deriveTopic,
  estimateTokens,
  clipToTokens,
} from '../server/memory/brief.js';

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

// Cả hai bộ rules phải nằm trong ngân sách phần rules — nếu vượt, joinBrief
// cắt âm thầm và mất đúng phần luật cuối cùng.
for (const [name, rules] of [
  ['coach', RULES],
  ['interview', INTERVIEW_RULES],
  ['reflex', REFLEX_RULES],
] as const) {
  const t = estimateTokens(rules);
  check(`rules ${name} ≤ ${SECTION_BUDGET.rules} token`, t <= SECTION_BUDGET.rules, `${t} token`);
  check(`rules ${name} không bị cắt`, clipToTokens(rules, SECTION_BUDGET.rules) === rules.trim());
}

// Integration: brief thật từ DB.
const db = createDb(process.env.DATABASE_URL!);
const brief = await composeBrief(db, { coach: 'interview' });
// Brief đầy đủ chỉ in khi cần: mặc định chỉ in kết luận, để log ngắn và không
// bị cắt khi chạy trong CI hay terminal giới hạn dòng.
if (process.argv.includes('--brief')) {
  console.log('\n--- brief ---\n' + brief.text + '\n-------------');
}
console.log(`tokens: ${brief.tokens} / ${BRIEF_BUDGET} (ước lượng 4 ký tự/token)\n`);

check('brief chế độ interview dùng INTERVIEW_RULES', brief.text.includes('You are the interviewer'));
check('brief chế độ interview không sửa lỗi từng lượt', !brief.text.includes('Correct at most TWO'));
check(
  'chủ đề interview không phải hội thoại ôn cụm từ',
  !brief.text.includes('work conversation that naturally uses'),
  brief.text.slice(brief.text.indexOf('<today>'), brief.text.indexOf('</today>')).replace(/\n/g, ' | '),
);
check(
  'interview có nhắc cụm đến hạn ở dạng lời mời dùng',
  brief.text.includes('Create a natural chance for me to use'),
);

// deriveTopic phải rẽ nhánh theo vai, không chỉ đổi rules.
const sample = { dueVocab: [{ phrase: 'that\'s a good question' }], topMistakes: [], sessionCount: 0 };
check('deriveTopic coach vẫn dùng cụm đến hạn', deriveTopic(sample).startsWith('work conversation'));
check('deriveTopic interview xoay vòng câu chuyện', deriveTopic({ ...sample, coach: 'interview' }).startsWith('mock interview'));

// Profile không được bị cắt: cắt là mất đúng phần "Numbers I must defend" ở cuối.
const profileBody = brief.parts.profile;
check('profile không bị cắt', !profileBody.trimEnd().endsWith('…'));
check('profile còn phần số liệu', profileBody.includes('Numbers I must defend'), `${estimateTokens(profileBody)} / ${SECTION_BUDGET.profile} token`);

// Vai phản xạ: luật khác hẳn, và chủ đề phải là câu hỏi nhanh, không phải STAR.
const reflexBrief = await composeBrief(db, { coach: 'reflex' });
check('brief chế độ reflex dùng REFLEX_RULES', reflexBrief.text.includes('rapid-fire English drill'));
check('reflex không yêu cầu STAR', !reflexBrief.text.includes('Correct at most TWO'));
check(
  'chủ đề reflex xoay giữa phỏng vấn nhanh và small talk',
  reflexBrief.text.includes('rapid-fire'),
  reflexBrief.topic,
);
check('brief reflex ≤ 1.000 token', reflexBrief.tokens <= BRIEF_BUDGET, `${reflexBrief.tokens}`);

// Vai reason: rules riêng, chủ đề lập luận, và cụm đến hạn vẫn được luồn vào.
const reasonBrief = await composeBrief(db, { coach: 'reason' });
check('brief reason dùng REASON_RULES', reasonBrief.parts.rules === REASON_RULES);
check(
  'reason có nhắc cụm đến hạn ở dạng lời mời dùng',
  reasonBrief.text.includes('Create a natural chance for me to use'),
);
check('chủ đề reason là lập luận', reasonBrief.topic.startsWith('mock reasoning on'), reasonBrief.topic);
check('brief reason ≤ 1.000 token', reasonBrief.tokens <= BRIEF_BUDGET, `${reasonBrief.tokens}`);

// Hợp đồng HTTP: zod lặng lẽ bỏ field không khai báo, nên độ trễ sẽ biến mất
// giữa client và DB mà không có lỗi nào. Đây là chỗ dễ tái phát nhất.
const parsedEvents = eventsSchema.safeParse({
  turns: [{ role: 'user', text: 'One month.', firstWordMs: 1800 }],
});
check('API nhận firstWordMs', parsedEvents.success && parsedEvents.data.turns?.[0]?.firstWordMs === 1800);

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
