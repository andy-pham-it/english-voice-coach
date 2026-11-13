// Chạy trích xuất sau phiên rồi ghi vào DB. Xem spec §10.6 + §11.
//
// Hai điều quan trọng:
//  1. Phiên đã có transcript thì luôn được lưu, kể cả khi LLM fail — job retry
//     chỉ cần tìm các phiên `status='ended' and summary is null`.
//  2. `mistakes` unique trên `pattern`, nên `count` cộng dồn qua các phiên thay
//     vì sinh ra 20 dòng trùng nghĩa.

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { mistakes, sessions, turns, usageDaily, vocab } from '../db/schema.js';
import { env } from '../env.js';
import { dueVocabQuery } from '../memory/brief.js';
import { RELEARN_DAYS, scheduleReview } from '../review/schedule.js';
import { EXTRACT_SYSTEM, buildExtractPrompt, trimTranscript, type TranscriptTurn } from './prompt.js';
import { parseJsonLoose, callProvider, GEMINI_EXTRACT_MODEL, type ExtractProvider } from './providers.js';
import { extractionSchema, type Correction, type Extraction, type TomorrowPhrase } from './schema.js';

export interface ExtractRun {
  extraction: Extraction;
  provider: ExtractProvider;
  model: string;
  tokens: number;
}

export interface ExtractContext {
  topicHint?: string | null;
  durationSec?: number | null;
  topMistakes?: string[];
  /** Cụm đang đến hạn — chỉ những cụm này mới được tính là `used_phrases`. */
  duePhrases?: string[];
}

export interface ExtractOptions {
  provider?: ExtractProvider;
  model?: string;
  signal?: AbortSignal;
}

/** Chọn provider theo env: có GROQ_API_KEY thì dùng Groq, không thì Gemini. */
export function pickProvider(explicit?: ExtractProvider): { provider: ExtractProvider; apiKey: string; model?: string } {
  const e = env();
  if (explicit === 'groq') {
    if (!e.GROQ_API_KEY) throw new Error('Thiếu GROQ_API_KEY để chạy provider groq');
    return { provider: 'groq', apiKey: e.GROQ_API_KEY };
  }
  if (e.GROQ_API_KEY) return { provider: 'groq', apiKey: e.GROQ_API_KEY };
  return { provider: 'gemini', apiKey: e.GEMINI_API_KEY, model: GEMINI_EXTRACT_MODEL };
}

/**
 * Trích xuất từ transcript. Không ghi DB — tách khỏi `applyExtraction` để test
 * được prompt/schema mà không làm bẩn dữ liệu.
 */
export async function extractTranscript(
  transcriptTurns: TranscriptTurn[],
  context: ExtractContext = {},
  options: ExtractOptions = {},
): Promise<ExtractRun> {
  const trimmed = trimTranscript(transcriptTurns);
  const prompt = buildExtractPrompt(trimmed, context);
  const chosen = pickProvider(options.provider);

  const { text, model, tokens } = await callProvider({
    provider: chosen.provider,
    model: options.model ?? chosen.model ?? '',
    system: EXTRACT_SYSTEM,
    prompt,
    apiKey: chosen.apiKey,
    signal: options.signal,
  });

  const parsed = extractionSchema.safeParse(parseJsonLoose(text));
  if (!parsed.success) {
    throw new Error(
      `LLM trả JSON sai schema — ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }

  return { extraction: parsed.data, provider: chosen.provider, model, tokens };
}

export interface ApplyResult {
  sessionId: number;
  corrections: number;
  phrases: number;
  turnsMatched: number;
  tomorrow: TomorrowPhrase[];
}

/**
 * Ghi kết quả trích xuất. Gọi lại nhiều lần cho cùng một phiên phải an toàn:
 * `mistakes.count` chỉ cộng khi correction chưa từng được ghi cho phiên đó —
 * kiểm tra bằng cách so `sessions.summary` trước khi ghi.
 *
 * Lịch ôn do `scheduleReview` quyết định, không còn hằng số rải rác ở đây: mỗi
 * mục mang theo `streak` (số lần đúng liên tiếp) để lần đúng thứ n đẩy hạn xa
 * dần, và sai lại thì kéo về 1 ngày.
 */
export async function applyExtraction(
  db: Db,
  sessionId: number,
  extraction: Extraction,
  meta: { provider: string; model: string; tokens: number },
): Promise<ApplyResult> {
  const [session] = await db
    .select({ summary: sessions.summary, status: sessions.status, tomorrow: sessions.tomorrow })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!session) throw new Error(`Không có session ${sessionId}`);

  // Idempotent: đã có summary nghĩa là bước này đã chạy xong.
  if (session.summary) {
    return { sessionId, corrections: 0, phrases: 0, turnsMatched: 0, tomorrow: (session.tomorrow ?? []) as TomorrowPhrase[] };
  }

  const now = new Date();
  const updated = await db
    .update(sessions)
    .set({ topic: extraction.topic, summary: extraction.summary, status: 'ended', endedAt: now, tomorrow: extraction.tomorrow })
    .where(eq(sessions.id, sessionId))
    .returning({ id: sessions.id });

  // Session bị xoá trong lúc chờ LLM (dọn dữ liệu test, hoặc timeout rồi bị
  // retry khác thay thế): không ghi mistakes cho một phiên không còn tồn tại.
  if (!updated.length) {
    return { sessionId, corrections: 0, phrases: 0, turnsMatched: 0, tomorrow: (session.tomorrow ?? []) as TomorrowPhrase[] };
  }

  // Chuỗi đúng hiện có phải đọc trước khi ghi: quyết định hạn ôn dựa trên nó,
  // và cùng một cụm có thể vừa xuất hiện ở new_phrases vừa ở used_phrases.
  const correctionPatterns = extraction.corrections.map((c) => c.pattern);
  // Pattern vừa bị sửa trong phiên này thì vẫn tính là lỗi tái phát, không tính
  // là đã sửa — nếu không, một câu sai rồi tự sửa sẽ được thưởng oan.
  const fixedPatterns = extraction.fixed_patterns.filter((p) => !correctionPatterns.includes(p));
  const vocabPhrases = [...new Set([...extraction.new_phrases, ...extraction.used_phrases])];

  const mistakeStreak = new Map<string, number>();
  if (correctionPatterns.length || fixedPatterns.length) {
    const rows = await db
      .select({ pattern: mistakes.pattern, streak: mistakes.streak })
      .from(mistakes)
      .where(inArray(mistakes.pattern, [...new Set([...correctionPatterns, ...fixedPatterns])]));
    for (const r of rows) mistakeStreak.set(r.pattern, r.streak);
  }

  const vocabStreak = new Map<string, number>();
  if (vocabPhrases.length) {
    const rows = await db
      .select({ phrase: vocab.phrase, streak: vocab.streak })
      .from(vocab)
      .where(inArray(vocab.phrase, vocabPhrases));
    for (const r of rows) vocabStreak.set(r.phrase, r.streak);
  }

  // Lỗi tái phát: đứt chuỗi, hẹn lại ngày mai.
  for (const c of extraction.corrections) {
    const s = scheduleReview(now, 'again', mistakeStreak.get(c.pattern) ?? 0);
    await db
      .insert(mistakes)
      .values({
        pattern: c.pattern,
        wrong: c.wrong,
        right: c.right,
        note: c.note,
        count: 1,
        streak: s.streak,
        lastSeen: now,
        nextReview: s.nextReview,
      })
      .onConflictDoUpdate({
        target: mistakes.pattern,
        set: {
          wrong: c.wrong,
          right: c.right,
          note: c.note,
          count: sql`${mistakes.count} + 1`,
          streak: s.streak,
          lastSeen: now,
          nextReview: s.nextReview,
          active: true,
        },
      });
  }

  // Lỗi cũ mà phiên này đã dùng đúng: cộng chuỗi, đẩy hạn xa dần; đủ chuỗi thì
  // rời danh sách nhắc và không còn nằm trong prompt của các phiên sau.
  for (const pattern of fixedPatterns) {
    const s = scheduleReview(now, 'correct', mistakeStreak.get(pattern) ?? 0);
    await db
      .update(mistakes)
      .set({ streak: s.streak, nextReview: s.nextReview, active: !s.graduated })
      .where(eq(mistakes.pattern, pattern));
  }

  // Cụm từ tốt người học tự dùng đúng: cũng leo bậc như trên.
  for (const phrase of extraction.new_phrases) {
    const s = scheduleReview(now, 'correct', vocabStreak.get(phrase) ?? 0);
    await db
      .insert(vocab)
      .values({ phrase, count: 1, streak: s.streak, nextReview: s.nextReview })
      .onConflictDoUpdate({
        target: vocab.phrase,
        set: { count: sql`${vocab.count} + 1`, streak: s.streak, nextReview: s.nextReview },
      });
  }

  // Cụm đến hạn mà người học đã dùng đúng trong phiên này.
  for (const phrase of extraction.used_phrases) {
    const s = scheduleReview(now, 'correct', vocabStreak.get(phrase) ?? 0);
    await db
      .update(vocab)
      .set({ count: sql`${vocab.count} + 1`, streak: s.streak, nextReview: s.nextReview })
      .where(eq(vocab.phrase, phrase));
  }

  // Câu dùng được ngay mai: chưa phải bằng chứng đã nhớ, nên không leo bậc —
  // cố định 1 ngày để phiên sau nhắc lại, leo bậc chỉ khi thực sự dùng đúng.
  for (const t of extraction.tomorrow) {
    const nextReview = new Date(now.getTime() + RELEARN_DAYS * 24 * 60 * 60 * 1000);
    await db
      .insert(vocab)
      .values({ phrase: t.en, example: t.vi, count: 1, streak: 0, nextReview })
      .onConflictDoUpdate({
        target: vocab.phrase,
        set: { count: sql`${vocab.count} + 1`, streak: 0, nextReview },
      });
  }

  const turnsMatched = await attachCorrectionsToTurns(db, sessionId, extraction.corrections);

  await db
    .insert(usageDaily)
    .values({ day: now.toISOString().slice(0, 10), extractTokens: meta.tokens, extractRequests: 1 })
    .onConflictDoUpdate({
      target: usageDaily.day,
      set: {
        extractTokens: sql`${usageDaily.extractTokens} + ${meta.tokens}`,
        extractRequests: sql`${usageDaily.extractRequests} + 1`,
      },
    });

  return {
    sessionId,
    corrections: extraction.corrections.length,
    phrases: extraction.new_phrases.length,
    turnsMatched,
    tomorrow: extraction.tomorrow,
  };
}

/**
 * Gắn correction vào đúng lượt của người học để UI transcript gạch chân được.
 * Khớp mờ: tìm turn user đầu tiên có chứa nguyên văn cụm sai.
 */
async function attachCorrectionsToTurns(
  db: Db,
  sessionId: number,
  corrections: Correction[],
): Promise<number> {
  if (!corrections.length) return 0;
  const byTurn = new Map<number, Correction[]>();

  for (const c of corrections) {
    const [hit] = await db
      .select({ id: turns.id })
      .from(turns)
      .where(
        and(
          eq(turns.sessionId, sessionId),
          eq(turns.role, 'user'),
          sql`${turns.text} ilike ${'%' + c.wrong.slice(0, 60) + '%'}`,
        ),
      )
      .limit(1);
    if (!hit) continue;
    const list = byTurn.get(hit.id) ?? [];
    list.push(c);
    byTurn.set(hit.id, list);
  }

  for (const [turnId, list] of byTurn) {
    await db.update(turns).set({ corrections: list }).where(eq(turns.id, turnId));
  }
  return byTurn.size;
}

/** Đọc phiên từ DB rồi chạy trọn bước trích xuất + ghi. */
export async function extractAndStore(
  db: Db,
  sessionId: number,
  options: ExtractOptions = {},
): Promise<ApplyResult & { extraction: Extraction; provider: string; model: string; tokens: number }> {
  const [session] = await db
    .select({
      id: sessions.id,
      topic: sessions.topic,
      durationSec: sessions.durationSec,
      summary: sessions.summary,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!session) throw new Error(`Không có session ${sessionId}`);

  const rows = await db
    .select({ role: turns.role, text: turns.text })
    .from(turns)
    .where(eq(turns.sessionId, sessionId))
    .orderBy(turns.createdAt);

  if (!rows.length) throw new Error(`Session ${sessionId} không có lượt nào để trích xuất`);

  const topMistakes = await db
    .select({ pattern: mistakes.pattern })
    .from(mistakes)
    .where(eq(mistakes.active, true))
    .orderBy(sql`${mistakes.count} desc`)
    .limit(5);

  // Cụm đến hạn: cùng điều kiện với `dueVocab` trong brief, để LLM chỉ được
  // chọn `used_phrases` từ danh sách người học thực sự đang được nhắc.
  const duePhrases = await dueVocabQuery(db);

  const run = await extractTranscript(rows, {
    topicHint: session.topic,
    durationSec: session.durationSec,
    topMistakes: topMistakes.map((m) => m.pattern),
    duePhrases: duePhrases.map((v) => v.phrase),
  }, options);

  const applied = await applyExtraction(db, sessionId, run.extraction, {
    provider: run.provider,
    model: run.model,
    tokens: run.tokens,
  });

  return { ...applied, extraction: run.extraction, provider: run.provider, model: run.model, tokens: run.tokens };
}
