import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/** Postgres `tsvector` — Drizzle không có type sẵn. */
const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

/** Danh sách pattern lỗi đóng — xem spec §10.5. */
export const MISTAKE_PATTERNS = [
  'past_tense',
  'present_perfect',
  'third_person_s',
  'article',
  'preposition',
  'plural',
  'subject_verb_agreement',
  'word_order',
  'missing_auxiliary',
  'verb_pattern',
  'countable_uncountable',
  'comparative',
  'conditional',
  'relative_clause',
  'phrasal_verb',
  'vocabulary_choice',
  'register',
  'filler_overuse',
  'run_on',
  'directness',
] as const;

export type MistakePattern = (typeof MISTAKE_PATTERNS)[number];

export const SESSION_MODES = ['duplex', 'ptt'] as const;
export const SESSION_STATUSES = ['active', 'ended', 'abandoned'] as const;

export const learnerProfile = pgTable('learner_profile', {
  id: smallint('id').primaryKey().default(1),
  contentMd: text('content_md').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check('learner_profile_single_row', sql`${t.id} = 1`),
]);

export const sessions = pgTable('sessions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  durationSec: integer('duration_sec'),
  topic: text('topic'),
  summary: text('summary'),
  /** Nguyên văn systemInstruction đã nạp — bản chụp, không render lại. */
  brief: text('brief'),
  briefTokens: integer('brief_tokens'),
  /** 3 câu dùng được ở chỗ làm, sinh từ lỗi của chính phiên này. */
  tomorrow: jsonb('tomorrow').$type<{ en: string; vi: string; tag: string }[]>(),
  liveModel: text('live_model'),
  mode: text('mode', { enum: SESSION_MODES }),
  status: text('status', { enum: SESSION_STATUSES }).notNull().default('active'),
  search: tsvector('search').generatedAlwaysAs(
    sql`to_tsvector('english', coalesce(topic, '') || ' ' || coalesce(summary, ''))`,
  ),
}, (t) => [
  index('sessions_search_idx').using('gin', t.search),
  index('sessions_started_at_idx').on(t.startedAt),
  check('sessions_mode_check', sql`${t.mode} is null or ${t.mode} in ('duplex', 'ptt')`),
  check('sessions_status_check', sql`${t.status} in ('active', 'ended', 'abandoned')`),
]);

export const turns = pgTable('turns', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  sessionId: bigint('session_id', { mode: 'number' })
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  role: text('role', { enum: ['user', 'assistant'] }).notNull(),
  text: text('text').notNull(),
  /** Chỉ có ở role='user', điền sau phiên — Live API không trả correction. */
  corrections: jsonb('corrections'),
  audioMs: integer('audio_ms'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  search: tsvector('search').generatedAlwaysAs(
    sql`to_tsvector('english', text)`,
  ),
}, (t) => [
  index('turns_search_idx').using('gin', t.search),
  index('turns_session_idx').on(t.sessionId, t.createdAt),
  check('turns_role_check', sql`${t.role} in ('user', 'assistant')`),
]);

export const mistakes = pgTable('mistakes', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  pattern: text('pattern').notNull(),
  wrong: text('wrong').notNull(),
  right: text('right').notNull(),
  note: text('note'),
  count: integer('count').notNull().default(1),
  /** Chuỗi lần dùng đúng liên tiếp. Xem server/review/schedule.ts. */
  streak: integer('streak').notNull().default(0),
  firstSeen: timestamp('first_seen', { withTimezone: true }).notNull().defaultNow(),
  lastSeen: timestamp('last_seen', { withTimezone: true }).notNull().defaultNow(),
  nextReview: timestamp('next_review', { withTimezone: true }),
  active: boolean('active').notNull().default(true),
}, (t) => [
  // count chỉ cộng được nếu mỗi pattern chỉ có một dòng.
  uniqueIndex('mistakes_pattern_idx').on(t.pattern),
]);

export const vocab = pgTable('vocab', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  phrase: text('phrase').notNull().unique(),
  example: text('example'),
  count: integer('count').notNull().default(1),
  /** Chuỗi lần dùng đúng liên tiếp. Xem server/review/schedule.ts. */
  streak: integer('streak').notNull().default(0),
  nextReview: timestamp('next_review', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const usageDaily = pgTable('usage_daily', {
  day: date('day').primaryKey(),
  liveAudioSec: integer('live_audio_sec').notNull().default(0),
  liveTokens: integer('live_tokens').notNull().default(0),
  extractTokens: integer('extract_tokens').notNull().default(0),
  extractRequests: integer('extract_requests').notNull().default(0),
});

/**
 * Log của spike đo T1/T3/V1. Bảng tạm, không thuộc sản phẩm: spike chạy trên
 * điện thoại không POST được về localhost, nên đẩy thẳng vào Neon.
 * `run_id` unique để gửi lại cùng một lần đo không sinh dòng thứ hai.
 */
export const spikeRuns = pgTable('spike_runs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  runId: text('run_id').notNull(),
  payload: jsonb('payload').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('spike_runs_run_id_idx').on(t.runId),
]);

export type Session = typeof sessions.$inferSelect;
export type Turn = typeof turns.$inferSelect;
export type Mistake = typeof mistakes.$inferSelect;
export type Vocab = typeof vocab.$inferSelect;
