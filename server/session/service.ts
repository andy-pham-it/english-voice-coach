import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { mistakes, sessions, turns, usageDaily, vocab, type Session } from '../db/schema.js';
import { env } from '../env.js';
import { composeBrief, DEFAULT_PROFILE } from '../memory/brief.js';
import { buildLiveConfig, LIVE_MODEL } from '../live/config.js';
import { createLiveToken, liveSocketUrl } from '../live/token.js';
import { extractAndStore } from '../extract/run.js';
import { learnerProfile } from '../db/schema.js';

export const RESUME_WINDOW_MS = 15 * 60 * 1000;
export const ABANDON_WINDOW_MS = 30 * 60 * 1000;
/** Bước trích xuất có thể chậm (free tier 503 + đổi model); quá hạn thì để pending. */
export const EXTRACT_TIMEOUT_MS = 30_000;

export type SessionMode = 'duplex' | 'ptt';

export interface LiveHandle {
  token: string;
  socket: string;
  expiresAt: string;
}

export interface StartResult {
  resumed: boolean;
  session: Session;
  brief: string;
  briefTokens: number;
  recap: Recap;
  live: LiveHandle;
  model: string;
}

export interface Recap {
  mistakes: Array<{ pattern: string; wrong: string; right: string; count: number; lastSeen: string }>;
  dueVocab: string[];
}

async function issueToken(brief: string): Promise<LiveHandle> {
  const token = await createLiveToken({
    apiKey: env().GEMINI_API_KEY,
    setup: buildLiveConfig({ brief }),
  });
  return {
    token: token.name,
    socket: liveSocketUrl(token.name),
    expiresAt: token.expireTime,
  };
}

/**
 * Nạp lại đúng những gì AI sắp đọc: 5 lỗi lặp + 3 cụm từ đến hạn. Đây là dữ
 * liệu để G3 đo được — card có gì thì brief chắc chắn có cái đó.
 */
export async function getRecap(db: Db): Promise<Recap> {
  const top = await db
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

  const due = await db
    .select({ phrase: vocab.phrase })
    .from(vocab)
    .where(sql`${vocab.nextReview} is null or ${vocab.nextReview} <= now()`)
    .orderBy(desc(vocab.count))
    .limit(3);

  return {
    mistakes: top.map((m) => ({
      pattern: m.pattern,
      wrong: m.wrong,
      right: m.right,
      count: m.count,
      lastSeen: m.lastSeen.toISOString(),
    })),
    dueVocab: due.map((v) => v.phrase),
  };
}

export async function startSession(db: Db, options: { mode: SessionMode }): Promise<StartResult> {
  const now = Date.now();
  const [active] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.status, 'active'))
    .orderBy(desc(sessions.startedAt))
    .limit(1);

  if (active) {
    const age = now - active.startedAt.getTime();
    if (age < RESUME_WINDOW_MS && active.brief) {
      return {
        resumed: true,
        session: active,
        brief: active.brief,
        briefTokens: active.briefTokens ?? 0,
        recap: await getRecap(db),
        live: await issueToken(active.brief),
        model: active.liveModel ?? LIVE_MODEL,
      };
    }
    // Cũ hơn cửa sổ resume: đóng lại để không có hai session active.
    await db
      .update(sessions)
      .set({ status: 'abandoned', endedAt: new Date(), durationSec: Math.round(age / 1000) })
      .where(eq(sessions.id, active.id));
  }

  const brief = await composeBrief(db);
  const [created] = await db
    .insert(sessions)
    .values({
      startedAt: new Date(now),
      topic: brief.topic,
      brief: brief.text,
      briefTokens: brief.tokens,
      liveModel: LIVE_MODEL,
      mode: options.mode,
      status: 'active',
    })
    .returning();

  if (!created) throw new Error('Không tạo được session');

  return {
    resumed: false,
    session: created,
    brief: brief.text,
    briefTokens: brief.tokens,
    recap: await getRecap(db),
    live: await issueToken(brief.text),
    model: LIVE_MODEL,
  };
}

export interface TurnEvent {
  role: 'user' | 'assistant';
  text: string;
  audioMs?: number;
  createdAt?: string;
}

export interface UsageEvent {
  audioSec?: number;
  tokens?: number;
}

export async function appendEvents(
  db: Db,
  sessionId: number,
  events: { turns?: TurnEvent[]; usage?: UsageEvent },
): Promise<{ turns: number; audioSec: number; tokens: number }> {
  const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  if (!session) throw Object.assign(new Error('session không tồn tại'), { status: 404 });
  if (session.status !== 'active') {
    throw Object.assign(new Error(`session đang ở trạng thái ${session.status}`), { status: 409 });
  }

  const rows = (events.turns ?? []).filter((t) => t.text.trim().length > 0);
  if (rows.length) {
    await db.insert(turns).values(
      rows.map((t) => ({
        sessionId,
        role: t.role,
        text: t.text,
        audioMs: t.audioMs ?? null,
        createdAt: t.createdAt ? new Date(t.createdAt) : new Date(),
      })),
    );
  }

  const audioSec = Math.round(events.usage?.audioSec ?? 0);
  const tokens = Math.round(events.usage?.tokens ?? 0);
  if (audioSec || tokens) {
    const day = new Date().toISOString().slice(0, 10);
    await db
      .insert(usageDaily)
      .values({ day, liveAudioSec: audioSec, liveTokens: tokens })
      .onConflictDoUpdate({
        target: usageDaily.day,
        set: {
          liveAudioSec: sql`${usageDaily.liveAudioSec} + ${audioSec}`,
          liveTokens: sql`${usageDaily.liveTokens} + ${tokens}`,
        },
      });
  }

  return { turns: rows.length, audioSec, tokens };
}

export interface EndResult {
  sessionId: number;
  status: string;
  durationSec: number;
  alreadyEnded: boolean;
  summary: string | null;
  topic: string | null;
  extract: 'done' | 'failed' | 'timeout' | 'skipped';
  corrections: number;
  items?: { wrong: string; right: string; pattern: string; note: string }[];
  phrases?: string[];
  error?: string;
}

export async function endSession(
  db: Db,
  sessionId: number,
  options: { durationSec?: number } = {},
): Promise<EndResult> {
  const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  if (!session) throw Object.assign(new Error('session không tồn tại'), { status: 404 });

  if (session.status !== 'active') {
    return {
      sessionId,
      status: session.status,
      durationSec: session.durationSec ?? 0,
      alreadyEnded: true,
      summary: session.summary,
      topic: session.topic,
      extract: 'skipped',
      corrections: 0,
    };
  }

  const endedAt = new Date();
  const durationSec =
    options.durationSec ?? Math.max(0, Math.round((endedAt.getTime() - session.startedAt.getTime()) / 1000));

  await db
    .update(sessions)
    .set({ status: 'ended', endedAt, durationSec })
    .where(eq(sessions.id, sessionId));

  // Huỷ request LLM khi hết giờ: nếu chỉ Promise.race rồi bỏ đi, request vẫn
  // chạy tiếp và ghi mistakes vào một session đã bị dọn — đúng lỗi đã gặp.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, EXTRACT_TIMEOUT_MS);

  try {
    const result = await extractAndStore(db, sessionId, { signal: controller.signal });
    return {
      sessionId,
      status: 'ended',
      durationSec,
      alreadyEnded: false,
      summary: result.extraction.summary,
      topic: result.extraction.topic,
      extract: 'done',
      corrections: result.corrections,
      items: result.extraction.corrections.map((c) => ({
        wrong: c.wrong,
        right: c.right,
        pattern: c.pattern,
        note: c.note ?? '',
      })),
      phrases: result.extraction.new_phrases,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      sessionId,
      status: 'ended',
      durationSec,
      alreadyEnded: false,
      summary: null,
      topic: session.topic,
      extract: timedOut ? 'timeout' : 'failed',
      corrections: 0,
      error: message,
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface RebriefResult {
  brief: string;
  briefTokens: number;
  live: LiveHandle;
  model: string;
}

/** Nối lại giữa phiên với brief mới — Live API không cho sửa instruction tại chỗ. */
export async function rebrief(db: Db, sessionId: number): Promise<RebriefResult> {
  const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  if (!session) throw Object.assign(new Error('session không tồn tại'), { status: 404 });
  if (session.status !== 'active') {
    throw Object.assign(new Error(`session đang ở trạng thái ${session.status}`), { status: 409 });
  }

  const brief = await composeBrief(db, { topic: session.topic ?? undefined });
  await db
    .update(sessions)
    .set({ brief: brief.text, briefTokens: brief.tokens })
    .where(eq(sessions.id, sessionId));

  return {
    brief: brief.text,
    briefTokens: brief.tokens,
    live: await issueToken(brief.text),
    model: session.liveModel ?? LIVE_MODEL,
  };
}

export interface ContextPayload {
  profile: string;
  brief: string | null;
  briefTokens: number;
  briefSessionId: number | null;
  mistakes: Array<{ id: number; pattern: string; wrong: string; right: string; count: number; lastSeen: string }>;
  dueVocab: Array<{ id: number; phrase: string; count: number; nextReview: string | null }>;
  week: { minutes: number; sessions: number };
  today: { audioSec: number; tokens: number; extractRequests: number };
}

export async function getContext(db: Db): Promise<ContextPayload> {
  const [profileRow] = await db
    .select({ contentMd: learnerProfile.contentMd })
    .from(learnerProfile)
    .where(eq(learnerProfile.id, 1))
    .limit(1);

  const weekStart = new Date(Date.now() - 7 * 86_400_000);
  const weekRows = await db
    .select({ durationSec: sessions.durationSec })
    .from(sessions)
    .where(and(eq(sessions.status, 'ended'), gte(sessions.startedAt, weekStart)));

  const [latest] = await db
    .select({
      id: sessions.id,
      brief: sessions.brief,
      briefTokens: sessions.briefTokens,
    })
    .from(sessions)
    .orderBy(desc(sessions.startedAt))
    .limit(1);

  const active = await db
    .select({
      id: mistakes.id,
      pattern: mistakes.pattern,
      wrong: mistakes.wrong,
      right: mistakes.right,
      count: mistakes.count,
      lastSeen: mistakes.lastSeen,
    })
    .from(mistakes)
    .where(eq(mistakes.active, true))
    .orderBy(desc(mistakes.count));

  const due = await db
    .select({
      id: vocab.id,
      phrase: vocab.phrase,
      count: vocab.count,
      nextReview: vocab.nextReview,
    })
    .from(vocab)
    .where(sql`${vocab.nextReview} is null or ${vocab.nextReview} <= now()`)
    .orderBy(desc(vocab.count))
    .limit(10);

  const day = new Date().toISOString().slice(0, 10);
  const [usage] = await db.select().from(usageDaily).where(eq(usageDaily.day, day)).limit(1);

  return {
    profile: profileRow?.contentMd ?? DEFAULT_PROFILE,
    brief: latest?.brief ?? null,
    briefTokens: latest?.briefTokens ?? 0,
    briefSessionId: latest?.id ?? null,
    mistakes: active.map((m) => ({
      id: m.id,
      pattern: m.pattern,
      wrong: m.wrong,
      right: m.right,
      count: m.count,
      lastSeen: m.lastSeen.toISOString(),
    })),
    dueVocab: due.map((v) => ({
      id: v.id,
      phrase: v.phrase,
      count: v.count,
      nextReview: v.nextReview?.toISOString() ?? null,
    })),
    week: {
      minutes: Math.round(weekRows.reduce((sum, r) => sum + (r.durationSec ?? 0), 0) / 60),
      sessions: weekRows.length,
    },
    today: {
      audioSec: usage?.liveAudioSec ?? 0,
      tokens: usage?.liveTokens ?? 0,
      extractRequests: usage?.extractRequests ?? 0,
    },
  };
}

export async function saveProfile(db: Db, contentMd: string): Promise<void> {
  await db
    .insert(learnerProfile)
    .values({ id: 1, contentMd, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: learnerProfile.id,
      set: { contentMd, updatedAt: new Date() },
    });
}

export async function deactivateMistake(db: Db, id: number): Promise<boolean> {
  const rows = await db
    .update(mistakes)
    .set({ active: false })
    .where(eq(mistakes.id, id))
    .returning({ id: mistakes.id });
  return rows.length > 0;
}
