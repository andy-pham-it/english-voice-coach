// Danh sách phiên đã nói + chi tiết một phiên. Chỉ đọc — mọi thứ đã được ghi
// lúc kết thúc phiên, nên tab History không cần gọi LLM.

import { desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { sessions, turns } from '../db/schema.js';
import type { Correction } from '../extract/schema.js';

export interface SessionListItem {
  id: number;
  topic: string | null;
  summary: string | null;
  status: string;
  mode: string | null;
  startedAt: string;
  durationSec: number | null;
  /** Số lượt của người học có correction — đủ để người dùng thấy phiên đó có gì. */
  corrections: number;
}

export interface SessionTurn {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  corrections: Correction[] | null;
  createdAt: string;
}

export interface SessionDetail extends SessionListItem {
  endedAt: string | null;
  brief: string | null;
  briefTokens: number | null;
  turns: SessionTurn[];
}

export async function listSessions(db: Db, limit = 20): Promise<SessionListItem[]> {
  const rows = await db
    .select({
      id: sessions.id,
      topic: sessions.topic,
      summary: sessions.summary,
      status: sessions.status,
      mode: sessions.mode,
      startedAt: sessions.startedAt,
      durationSec: sessions.durationSec,
    })
    .from(sessions)
    .orderBy(desc(sessions.startedAt))
    .limit(limit);

  const counts = await db
    .select({
      sessionId: turns.sessionId,
      n: sql<number>`coalesce(sum(jsonb_array_length(${turns.corrections})), 0)::int`,
    })
    .from(turns)
    .where(sql`${turns.corrections} is not null`)
    .groupBy(turns.sessionId);

  const bySession = new Map(counts.map((c) => [c.sessionId, c.n]));

  return rows.map((r) => ({
    id: r.id,
    topic: r.topic,
    summary: r.summary,
    status: r.status,
    mode: r.mode,
    startedAt: r.startedAt.toISOString(),
    durationSec: r.durationSec,
    corrections: bySession.get(r.id) ?? 0,
  }));
}

export async function getSessionDetail(db: Db, sessionId: number): Promise<SessionDetail | null> {
  const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  if (!session) return null;

  const rows = await db
    .select({
      id: turns.id,
      role: turns.role,
      text: turns.text,
      corrections: turns.corrections,
      createdAt: turns.createdAt,
    })
    .from(turns)
    .where(eq(turns.sessionId, sessionId))
    // Thứ tự nói, không phải thứ tự đồng hồ: client gửi event theo đúng thứ tự
    // nói nên id (bigserial) mới là nguồn sự thật. created_at có thể trùng ms
    // hoặc lệch giữa máy client và server, làm transcript bị đảo lượt.
    .orderBy(turns.id);

  const transcript: SessionTurn[] = rows.map((r) => ({
    id: r.id,
    role: r.role,
    text: r.text,
    corrections: (r.corrections as Correction[] | null) ?? null,
    createdAt: r.createdAt.toISOString(),
  }));

  return {
    id: session.id,
    topic: session.topic,
    summary: session.summary,
    status: session.status,
    mode: session.mode,
    startedAt: session.startedAt.toISOString(),
    endedAt: session.endedAt?.toISOString() ?? null,
    durationSec: session.durationSec,
    brief: session.brief,
    briefTokens: session.briefTokens,
    corrections: transcript.reduce((n, t) => n + (t.corrections?.length ?? 0), 0),
    turns: transcript,
  };
}
