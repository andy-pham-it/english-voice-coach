// Biên soạn brief — khối text duy nhất được nhét vào systemInstruction.
// Xem spec §10.1. Thứ tự cố định: rules → profile → state → recall → today.
// Brief phải ≤ 1.000 token; mỗi phần có ngân sách riêng và bị cắt từ dưới lên.

import { and, desc, eq, gte, isNull, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { learnerProfile, mistakes, sessions, vocab } from '../db/schema.js';

export const BRIEF_BUDGET = 1000;

/** Ngân sách từng phần, cộng lại đúng bằng BRIEF_BUDGET. */
export const SECTION_BUDGET = {
  rules: 250,
  profile: 250,
  state: 300,
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

export const RULES = `You are my English speaking coach. We talk about my real work as a backend engineer.
Rules:
- Always speak English. The conversation is always in English, never Vietnamese.
- Keep replies to 2-4 short sentences, natural spoken English.
- Correct at most TWO important mistakes per turn, then continue the conversation.
- Correction format: say the wrong phrase, then the right phrase, then ONE short reason (max 12 words).
- Never invent mistakes. If a sentence is correct, do not correct it.
- Always end with a short question so I keep talking.`;

export interface ComposeOptions {
  /** Chủ đề phiên, đã suy ra từ state. */
  topic: string;
  /** Cụm từ mở đầu gợi ý cho AI, thường là câu hỏi đầu tiên. */
  opener?: string;
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
 */
export function deriveTopic(input: {
  dueVocab: { phrase: string }[];
  topMistakes: { pattern: string }[];
  sessionCount: number;
}): string {
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

  const dueVocab = await db
    .select({ phrase: vocab.phrase })
    .from(vocab)
    .where(or(isNull(vocab.nextReview), sql`${vocab.nextReview} <= now()`))
    .orderBy(desc(vocab.count))
    .limit(5);

  const state = await loadStateRows(db);
  const topic = options?.topic ?? deriveTopic({ dueVocab, topMistakes, sessionCount: state.weekSessions });
  const recall = await loadRecall(db, topic);

  const today = [
    `Topic for this session: ${topic}.`,
    options?.opener ?? 'Start by asking me one short question about it.',
  ].join('\n');

  return joinBrief({
    rules: RULES,
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
