/**
 * Nguồn dữ liệu cho Drill — ôn nhanh không cần phiên Live.
 *
 * Cùng một khái niệm "đến hạn" với brief (`server/memory/brief.ts`) và
 * session start (`server/session/service.ts`): `nextReview is null or <= now()`.
 * Ba nơi phải lọc giống nhau, lệch một chỗ là item hiện ở nơi này mà biến mất
 * ở nơi khác.
 */

import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { mistakes, vocab } from '../db/schema.js';
import { scheduleReview, type ReviewOutcome } from './schedule.js';

export const DRILL_LIMIT_DEFAULT = 12;
export const DRILL_LIMIT_MAX = 40;

export type DrillKind = 'vocab' | 'mistake';

/**
 * Trả dữ liệu thô, không dựng sẵn câu hỏi: cách hiển thị phụ thuộc vào việc
 * item có `example`/`note` hay không, và client mới là nơi biết điều đó.
 */
export type DrillItem =
  | {
      kind: 'vocab';
      id: number;
      phrase: string;
      example: string | null;
      count: number;
      nextReview: string | null;
    }
  | {
      kind: 'mistake';
      id: number;
      pattern: string;
      wrong: string;
      right: string;
      note: string | null;
      count: number;
      nextReview: string | null;
    };

export interface DrillAnswer {
  streak: number;
  nextReview: string;
  graduated: boolean;
}

const dueCondition = (column: typeof vocab.nextReview | typeof mistakes.nextReview) =>
  or(isNull(column), sql`${column} <= now()`);

/** Item nào đến hạn trước thì đứng trước; cùng hạn thì cụm lặp nhiều hơn lên đầu. */
export async function listDrill(db: Db, limit = DRILL_LIMIT_DEFAULT): Promise<{ items: DrillItem[] }> {
  const [vocabRows, mistakeRows] = await Promise.all([
    db
      .select({
        id: vocab.id,
        phrase: vocab.phrase,
        example: vocab.example,
        count: vocab.count,
        nextReview: vocab.nextReview,
      })
      .from(vocab)
      .where(dueCondition(vocab.nextReview))
      .orderBy(sql`${vocab.nextReview} asc nulls last`, desc(vocab.count))
      .limit(limit),
    db
      .select({
        id: mistakes.id,
        pattern: mistakes.pattern,
        wrong: mistakes.wrong,
        right: mistakes.right,
        note: mistakes.note,
        count: mistakes.count,
        nextReview: mistakes.nextReview,
      })
      .from(mistakes)
      .where(and(eq(mistakes.active, true), dueCondition(mistakes.nextReview)))
      .orderBy(sql`${mistakes.nextReview} asc nulls last`, desc(mistakes.count))
      .limit(limit),
  ]);

  const items: DrillItem[] = [
    ...vocabRows.map((r) => ({
      kind: 'vocab' as const,
      id: r.id,
      phrase: r.phrase,
      example: r.example,
      count: r.count,
      nextReview: r.nextReview ? r.nextReview.toISOString() : null,
    })),
    ...mistakeRows.map((r) => ({
      kind: 'mistake' as const,
      id: r.id,
      pattern: r.pattern,
      wrong: r.wrong,
      right: r.right,
      note: r.note,
      count: r.count,
      nextReview: r.nextReview ? r.nextReview.toISOString() : null,
    })),
  ];

  // Gộp hai bảng rồi mới cắt: mỗi bảng lấy tối đa `limit` để không bỏ sót item
  // đến hạn sớm, nhưng tổng trả về vẫn đúng `limit`.
  items.sort((a, b) => {
    const at = a.nextReview ? Date.parse(a.nextReview) : 0;
    const bt = b.nextReview ? Date.parse(b.nextReview) : 0;
    if (at !== bt) return at - bt;
    return b.count - a.count;
  });

  return { items: items.slice(0, limit) };
}

const notFound = (kind: DrillKind, id: number): Error =>
  Object.assign(new Error(`${kind} ${id} không tồn tại`), { status: 404 });

/**
 * Ghi kết quả một lần tự chấm. Drill không đụng tới `count` — con số đó là số
 * lần item được *gặp trong hội thoại*, không phải số lần bấm nút.
 */
export async function answerDrill(
  db: Db,
  kind: DrillKind,
  id: number,
  outcome: ReviewOutcome,
  now = new Date(),
): Promise<DrillAnswer> {
  if (kind === 'vocab') {
    const [row] = await db.select({ streak: vocab.streak }).from(vocab).where(eq(vocab.id, id)).limit(1);
    if (!row) throw notFound(kind, id);

    const next = scheduleReview(now, outcome, row.streak);
    await db
      .update(vocab)
      .set({ streak: next.streak, nextReview: next.nextReview })
      .where(eq(vocab.id, id));

    return { ...next, nextReview: next.nextReview.toISOString() };
  }

  const [row] = await db.select({ streak: mistakes.streak }).from(mistakes).where(eq(mistakes.id, id)).limit(1);
  if (!row) throw notFound(kind, id);

  const next = scheduleReview(now, outcome, row.streak);
  await db
    .update(mistakes)
    .set({ streak: next.streak, nextReview: next.nextReview, active: !next.graduated })
    .where(eq(mistakes.id, id));

  return { ...next, nextReview: next.nextReview.toISOString() };
}
