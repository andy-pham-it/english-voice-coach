// Chạy trích xuất sau phiên rồi ghi vào DB. Xem spec §10.6 + §11.
//
// Hai điều quan trọng:
//  1. Phiên đã có transcript thì luôn được lưu, kể cả khi LLM fail — job retry
//     chỉ cần tìm các phiên `status='ended' and summary is null`.
//  2. `mistakes` unique trên `pattern`, nên `count` cộng dồn qua các phiên thay
//     vì sinh ra 20 dòng trùng nghĩa.

import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { mistakes, sessions, turns, usageDaily, vocab } from '../db/schema.js';
import { env } from '../env.js';
import { dueVocabQuery } from '../memory/brief.js';
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

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Ghi kết quả trích xuất. Gọi lại nhiều lần cho cùng một phiên phải an toàn:
 * `mistakes.count` chỉ cộng khi correction chưa từng được ghi cho phiên đó —
 * kiểm tra bằng cách so `sessions.summary` trước khi ghi.
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

  for (const c of extraction.corrections) {
    await db
      .insert(mistakes)
      .values({
        pattern: c.pattern,
        wrong: c.wrong,
        right: c.right,
        note: c.note,
        count: 1,
        lastSeen: now,
        nextReview: new Date(now.getTime() + DAY_MS),
      })
      .onConflictDoUpdate({
        target: mistakes.pattern,
        set: {
          wrong: c.wrong,
          right: c.right,
          note: c.note,
          count: sql`${mistakes.count} + 1`,
          lastSeen: now,
          nextReview: new Date(now.getTime() + DAY_MS),
          active: true,
        },
      });
  }

  // Cụm từ tốt: lần đầu thì đến hạn ôn sau 3 ngày, gặp lại thì đẩy xa hơn.
  for (const phrase of extraction.new_phrases) {
    await db
      .insert(vocab)
      .values({ phrase, count: 1, nextReview: new Date(now.getTime() + 3 * DAY_MS) })
      .onConflictDoUpdate({
        target: vocab.phrase,
        set: {
          count: sql`${vocab.count} + 1`,
          nextReview: new Date(now.getTime() + 7 * DAY_MS),
        },
      });
  }

  // Cụm đến hạn mà người học đã dùng đúng: đẩy hạn ôn xa 7 ngày.
  for (const phrase of extraction.used_phrases) {
    await db
      .update(vocab)
      .set({ count: sql`${vocab.count} + 1`, nextReview: new Date(now.getTime() + 7 * DAY_MS) })
      .where(eq(vocab.phrase, phrase));
  }

  // Câu dùng được ngay mai: vào vocab với hạn 1 ngày để phiên sau nhắc lại.
  for (const t of extraction.tomorrow) {
    await db
      .insert(vocab)
      .values({ phrase: t.en, example: t.vi, count: 1, nextReview: new Date(now.getTime() + DAY_MS) })
      .onConflictDoUpdate({
        target: vocab.phrase,
        set: { count: sql`${vocab.count} + 1`, nextReview: new Date(now.getTime() + DAY_MS) },
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
