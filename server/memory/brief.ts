// Biên soạn brief — khối text duy nhất được nhét vào systemInstruction.
// Xem spec §10.1. Thứ tự cố định: rules → profile → state → recall → today.
// Brief phải ≤ 1.000 token; mỗi phần có ngân sách riêng và bị cắt từ dưới lên.

import { and, desc, eq, gte, isNull, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { learnerProfile, mistakes, sessions, vocab } from '../db/schema.js';
import type { CoachMode } from '../db/schema.js';

export const BRIEF_BUDGET = 1000;

/**
 * Ngân sách từng phần, cộng lại đúng bằng BRIEF_BUDGET.
 * `profile` được 300 vì nó phải chứa cả các con số người học sẽ bị hỏi lại;
 * `state` chỉ cần 250 (5 lỗi + cụm đến hạn + số liệu tuần ≈ 120 token).
 */
export const SECTION_BUDGET = {
  rules: 250,
  profile: 300,
  state: 250,
  recall: 120,
  today: 80,
} as const;

export type BriefSection = keyof typeof SECTION_BUDGET;

export type BriefParts = Record<BriefSection, string>;

export interface Brief {
  text: string;
  tokens: number;
  parts: BriefParts;
  /** Chủ đề đã chọn cho phiên — lưu vào `sessions.topic`. */
  topic: string;
}

/**
 * Ước lượng token không cần tokenizer: tiếng Anh trung bình ~4 ký tự/token.
 * Đây là số dùng để cắt ngân sách, không phải số để báo hoá đơn.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.trim().length / 4);
}

/** Cắt text theo ngân sách token, cắt ở ranh giới từ và thêm "…". */
export function clipToTokens(text: string, maxTokens: number): string {
  const clean = text.trim();
  if (estimateTokens(clean) <= maxTokens) return clean;
  const maxChars = maxTokens * 4 - 1;
  const cut = clean.slice(0, Math.max(0, maxChars));
  const atWord = cut.lastIndexOf(' ');
  return (atWord > maxChars * 0.6 ? cut.slice(0, atWord) : cut).trimEnd() + '…';
}

export const PACE_RULE = '\n- Speak slightly slower; pause between clauses.';

export const RULES = `You are my English speaking coach. We talk about my real work as a backend engineer.
Rules:
- Always speak English. The conversation is always in English, never Vietnamese.
- Keep replies to 2-4 short sentences, natural spoken English.
- Correct at most TWO important mistakes per turn, then continue the conversation.
- Correction format: say the wrong phrase, then the right phrase, then ONE short reason (max 12 words).
- Never invent mistakes. If a sentence is correct, do not correct it.
- Always end with a short question so I keep talking.${PACE_RULE}`;

/**
 * Vai thứ hai: người phỏng vấn. Không sửa lỗi trong lúc trả lời — sửa ngay
 * giữa buổi là dạy cách chờ được sửa, không phải cách nói dưới áp lực.
 * Phản hồi gom về cuối buổi. Ngân sách 250 token như RULES.
 */
export const INTERVIEW_RULES = `You are the interviewer on a hiring panel. I am the candidate. This is a real interview, not a lesson.
Rules:
- Always speak English.
- Stay in role. Never teach, never correct grammar, never praise. "OK" or "Go on" is the most I get.
- One question at a time, 1-2 short sentences, then stop and wait.
- Before a new topic, press on my last answer: "What exactly did you do?", "How do you know?", "What did that cost?"
- Interrupt any answer past 90 seconds: "Give me the short version first."
- Challenge every number: where it came from, measured or estimated. If a claim sounds generic, say: "That is generic. What did you personally do?"
- After 8 minutes, step out of role: score me 1-5 on clarity, depth, numbers and honesty, one line of evidence each, then one model answer in four sentences.${PACE_RULE}`;

/**
 * Vai thứ ba: phản xạ. Câu hỏi đời thường và câu hỏi nhanh trong phỏng vấn.
 * Không dùng STAR: một câu 90 giây cho "what is your notice period" là tự trừ
 * điểm. Mục tiêu là trả lời trong 15-20 giây và bắt đầu nói trong 3 giây.
 */
export const REFLEX_RULES = `You are running a rapid-fire English drill. I answer fast, like in a real interview.
Rules:
- Always speak English.
- One short question per turn, maximum 10 words. Never explain, never teach, never praise.
- If my answer passes 20 seconds or turns into a story, cut in with "Next." and ask the next question.
- Do not correct grammar while the drill runs.
- Keep going: 12 to 15 questions, no commentary between them.
- After the last question, step out of role: list the 3 questions I answered worst, and for each give a 15-second model answer. Then name one filler word I used too often.
- Never ask two questions in one turn.${PACE_RULE}`;

export const REASON_RULES = `You are my reasoning coach. We talk about my real work as a backend engineer, in English.
Rules:
- Always speak English. Keep replies to 2-3 short sentences.
- Before I answer, I state a four-part frame: "Point, Reason, Example, Point" or "Problem, Cause, Fix, Impact" or "Situation, Task, Action, Result".
- Listen for those four parts. If one is missing, ask exactly one question about that part, then stop. Never supply the answer.
- If I speak past 45 seconds without a frame, cut in: "Give me your point first."
- Every third turn, make me ask you one short clarifying question before you continue. I need practice keeping the conversation alive.
- Never correct grammar during the drill. Note repeated wording only at the end.
- After 8 minutes, step out of role: score me 1-5 on structure, reasoning, evidence and conversation flow, one line of evidence each, then give one model answer in four sentences using the frame I used worst.${PACE_RULE}`;

export function rulesFor(coach: CoachMode): string {
  if (coach === 'reason') return REASON_RULES;
  if (coach === 'interview') return INTERVIEW_RULES;
  if (coach === 'reflex') return REFLEX_RULES;
  return RULES;
}

export interface ComposeOptions {
  /** Chủ đề phiên, đã suy ra từ state. */
  topic: string;
  /** Cụm từ mở đầu gợi ý cho AI, thường là câu hỏi đầu tiên. */
  opener?: string;
  /** Vai AI của phiên. Mặc định `coach`. */
  coach?: CoachMode;
}

interface StateRow {
  lastSessionAt: Date | null;
  lastSessionMin: number | null;
  lastTopic: string | null;
  weekMinutes: number;
  weekSessions: number;
  streakDays: number;
}

/** Số liệu tuần này + streak, tính bằng SQL, không gọi LLM. */
async function loadStateRows(db: Db): Promise<StateRow> {
  const [last] = await db
    .select({
      at: sessions.startedAt,
      min: sessions.durationSec,
      topic: sessions.topic,
    })
    .from(sessions)
    .where(eq(sessions.status, 'ended'))
    .orderBy(desc(sessions.startedAt))
    .limit(1);

  const [week] = await db
    .select({
      minutes: sql<number>`coalesce(sum(${sessions.durationSec}), 0)::int / 60`,
      n: sql<number>`count(*)::int`,
    })
    .from(sessions)
    .where(and(eq(sessions.status, 'ended'), gte(sessions.startedAt, sql`date_trunc('week', now())`)));

  const days = await db
    .select({ day: sql<string>`to_char(date_trunc('day', ${sessions.startedAt}), 'YYYY-MM-DD')` })
    .from(sessions)
    .where(eq(sessions.status, 'ended'))
    .groupBy(sql`date_trunc('day', ${sessions.startedAt})`)
    .orderBy(sql`date_trunc('day', ${sessions.startedAt}) desc`)
    .limit(60);

  // Streak: đếm các ngày liên tiếp tính từ hôm nay (hoặc hôm qua nếu hôm nay chưa nói).
  let streak = 0;
  const today = new Date();
  const dayMs = 86_400_000;
  const startOfToday = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const daySet = new Set(days.map((d) => d.day));
  const firstDay = daySet.has(new Date(startOfToday).toISOString().slice(0, 10))
    ? startOfToday
    : startOfToday - dayMs;
  for (let t = firstDay; daySet.has(new Date(t).toISOString().slice(0, 10)); t -= dayMs) streak++;

  return {
    lastSessionAt: last?.at ?? null,
    lastSessionMin: last?.min ? Math.round(last.min / 60) : null,
    lastTopic: last?.topic ?? null,
    weekMinutes: week?.minutes ?? 0,
    weekSessions: week?.n ?? 0,
    streakDays: streak,
  };
}

/**
 * Cụm đến hạn ôn — dùng chung cho brief và bước trích xuất, để prompt chỉ
 * được chọn `used_phrases` từ đúng danh sách người học đang được nhắc.
 * Có hạn gần nhất đứng trước (câu vừa học hôm qua thắng 3 cụm seed có
 * `next_review = null`), cùng hạn thì cụm lặp nhiều hơn đứng trước.
 */
export function dueVocabQuery(db: Db, limit = 5) {
  return db
    .select({ phrase: vocab.phrase })
    .from(vocab)
    .where(or(isNull(vocab.nextReview), sql`${vocab.nextReview} <= now()`))
    .orderBy(sql`${vocab.nextReview} asc nulls last`, desc(vocab.count))
    .limit(limit);
}

/** State: lỗi lặp lại, cụm từ đến hạn, số liệu tuần. Không bao giờ do LLM viết. */
export function renderState(
  rows: StateRow,
  topMistakes: { pattern: string; wrong: string; right: string; count: number; lastSeen: Date }[],
  dueVocab: { phrase: string }[],
): string {
  const lines: string[] = [];
  const date = rows.lastSessionAt ? rows.lastSessionAt.toISOString().slice(0, 10) : null;
  lines.push(
    date
      ? `Last session: ${date}, ${rows.lastSessionMin ?? '?'} min, topic "${rows.lastTopic ?? 'unknown'}"`
      : 'Last session: none — this is the first one.',
  );
  if (topMistakes.length) {
    lines.push('Repeating mistakes (most frequent first):');
    for (const m of topMistakes) {
      lines.push(`  - ${m.pattern} (${m.count}x, last ${m.lastSeen.toISOString().slice(0, 10)})  "${m.wrong}" → "${m.right}"`);
    }
  } else {
    lines.push('Repeating mistakes: none recorded yet.');
  }
  if (dueVocab.length) {
    lines.push(`Due for review: ${dueVocab.map((v) => `"${v.phrase}"`).join(', ')}`);
  }
  lines.push(
    `This week: ${rows.weekMinutes} min, ${rows.weekSessions} sessions, ${rows.streakDays}-day streak.`,
  );
  return lines.join('\n');
}

/** Recall: tối đa 2 đoạn summary cũ khớp chủ đề hôm nay (full-text). */
async function loadRecall(db: Db, topic: string): Promise<string> {
  const rows = await db
    .select({ topic: sessions.topic, summary: sessions.summary })
    .from(sessions)
    .where(
      and(
        eq(sessions.status, 'ended'),
        sql`${sessions.search} @@ plainto_tsquery('english', ${topic})`,
      ),
    )
    .orderBy(desc(sessions.startedAt))
    .limit(2);
  return rows
    .filter((r) => r.summary)
    .map((r) => `- ${r.topic ?? 'earlier session'}: ${r.summary}`)
    .join('\n');
}

/**
 * Suy ra chủ đề phiên từ State — không gọi LLM (spec §12).
 * Ưu tiên: cụm từ đến hạn → pattern lỗi lặp nhiều nhất → xoay vòng 6 chủ đề tĩnh.
 * Ở vai phỏng vấn thì KHÔNG dùng chủ đề "cuộc nói chuyện dùng cụm từ X": người
 * phỏng vấn mà mở đầu bằng một cụm từ ôn tập là sai vai. Thay bằng vòng xoay
 * câu chuyện sẽ bị hỏi thật.
 */
export function deriveTopic(input: {
  dueVocab: { phrase: string }[];
  topMistakes: { pattern: string }[];
  sessionCount: number;
  coach?: CoachMode;
}): string {
  if (input.coach === 'reason') {
    const topics = [
      'a technical decision I would defend with numbers',
      'a production incident from cause to fix',
      'why a migration was worth its cost',
      'a disagreement settled with evidence',
      'choosing between two competing fixes',
      'explaining a tradeoff to a non-technical manager',
    ];
    return `mock reasoning on ${topics[input.sessionCount % topics.length] ?? topics[0]}`;
  }
  if (input.coach === 'reflex') {
    // Hai ngân hàng xen kẽ theo buổi: câu nhanh trong phỏng vấn, và chuyện
    // thường ngày với đồng đội remote — chỗ B1+ lộ ra rõ nhất.
    return input.sessionCount % 2 === 0
      ? 'rapid-fire interview questions: notice period, salary, why us, questions for them'
      : 'rapid-fire small talk with a remote teammate: weekend, food, commute, holiday plans';
  }
  if (input.coach === 'interview') {
    const interviews = [
      'a delivery crisis I held together',
      'the process change that lifted on-time delivery',
      'bringing AI into an engineering workflow',
      'a technical decision I would make differently now',
      'why I am leaving my current role',
      'a disagreement I lost and what I changed after it',
      'a system I designed end to end',
      'explaining a migration to a non-technical manager',
    ];
    const pick = interviews[input.sessionCount % interviews.length] ?? interviews[0];
    return `mock interview on ${pick}`;
  }
  const firstDue = input.dueVocab[0];
  if (firstDue) {
    return `work conversation that naturally uses the phrase "${firstDue.phrase}"`;
  }
  const rotations = [
    'daily standup update',
    'code review discussion',
    'explaining a technical decision',
    'a technical disagreement with a teammate',
    'a job interview conversation',
    'small talk with a remote teammate',
  ];
  const rotation = rotations[input.sessionCount % rotations.length] ?? rotations[0] ?? 'daily standup update';
  const topPattern = input.topMistakes[0]?.pattern;
  if (!topPattern) return rotation;
  return `${rotation}, while watching my ${topPattern.replace(/_/g, ' ')} mistakes`;
}

export function joinBrief(parts: BriefParts, topic = ''): Brief {
  const sections: string[] = [];
  for (const key of Object.keys(SECTION_BUDGET) as BriefSection[]) {
    const body = clipToTokens(parts[key] ?? '', SECTION_BUDGET[key]);
    if (!body) continue;
    sections.push(`<${key}>\n${body}\n</${key}>`);
  }
  const text = sections.join('\n\n');
  return { text, tokens: estimateTokens(text), parts, topic };
}

/**
 * Biên soạn brief cho phiên mới. Chỉ đọc DB, không gọi AI, nên chạy được
 * trước khi biết kết quả bất kỳ bài test nào.
 */
export async function composeBrief(db: Db, options?: Partial<ComposeOptions>): Promise<Brief> {
  const [profileRow] = await db
    .select({ contentMd: learnerProfile.contentMd })
    .from(learnerProfile)
    .where(eq(learnerProfile.id, 1))
    .limit(1);

  const topMistakes = await db
    .select({
      pattern: mistakes.pattern,
      wrong: mistakes.wrong,
      right: mistakes.right,
      count: mistakes.count,
      lastSeen: mistakes.lastSeen,
    })
    .from(mistakes)
    .where(eq(mistakes.active, true))
    .orderBy(desc(mistakes.count), desc(mistakes.lastSeen))
    .limit(5);

  const dueVocab = await dueVocabQuery(db);

  const state = await loadStateRows(db);
  const topic = options?.topic ?? deriveTopic({ dueVocab, topMistakes, sessionCount: state.weekSessions, coach: options?.coach });
  const recall = await loadRecall(db, topic);

  const coach = options?.coach ?? 'coach';
  const interview = coach === 'interview';
  const reflex = coach === 'reflex';
  const reason = coach === 'reason';
  const reviewLine =
    (interview || reflex || reason) && dueVocab.length
      ? // Ở vai phỏng vấn, cụm ôn tập không được biến thành chủ đề. Cách duy nhất
        // để cụm từ còn được luyện là để người phỏng vấn tạo chỗ dùng chúng.
        `Create a natural chance for me to use: ${dueVocab.slice(0, 3).map((v) => `"${v.phrase}"`).join(', ')}.`
      : null;
  const today = [
    `Topic for this session: ${topic}.`,
    options?.opener ??
      (reflex
        ? 'Ask the first question now. One short question, then wait.'
        : reason
          ? 'Open with one short question that needs a reason, not a fact.'
          : interview
            ? 'Open with your first question. One at a time, and wait for my answer.'
            : 'Start by asking me one short question about it.'),
    reviewLine,
  ]
    .filter(Boolean)
    .join('\n');

  return joinBrief({
    rules: rulesFor(coach),
    profile: profileRow?.contentMd ?? '',
    state: renderState(state, topMistakes, dueVocab),
    recall: recall ? `Relevant earlier sessions:\n${recall}` : '',
    today,
  }, topic);
}

/** Profile mặc định cho lần chạy đầu — người dùng sửa được ở tab Context. */
export const DEFAULT_PROFILE = `## Who I am
Backend engineer (Node/TypeScript), 4 years, Vietnam. My team has 6 people across 3 timezones.

## Goals
- Run a 10-minute standup update without freezing.
- Defend a technical decision when challenged.

## Level
B1 to B2. I understand fast speech but struggle with past tense and articles when speaking.

## Topics I care about
System design, database performance, code review, hiring, remote work.`;
