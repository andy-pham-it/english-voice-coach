CREATE TABLE "learner_profile" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"content_md" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "learner_profile_single_row" CHECK ("learner_profile"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "mistakes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"pattern" text NOT NULL,
	"wrong" text NOT NULL,
	"right" text NOT NULL,
	"note" text,
	"count" integer DEFAULT 1 NOT NULL,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"next_review" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"duration_sec" integer,
	"topic" text,
	"summary" text,
	"brief" text,
	"brief_tokens" integer,
	"live_model" text,
	"mode" text,
	"status" text DEFAULT 'active' NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(topic, '') || ' ' || coalesce(summary, ''))) STORED,
	CONSTRAINT "sessions_mode_check" CHECK ("sessions"."mode" is null or "sessions"."mode" in ('duplex', 'ptt')),
	CONSTRAINT "sessions_status_check" CHECK ("sessions"."status" in ('active', 'ended', 'abandoned'))
);
--> statement-breakpoint
CREATE TABLE "turns" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"session_id" bigint NOT NULL,
	"role" text NOT NULL,
	"text" text NOT NULL,
	"corrections" jsonb,
	"audio_ms" integer,
	"created_at" timestamp with time zone NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
	CONSTRAINT "turns_role_check" CHECK ("turns"."role" in ('user', 'assistant'))
);
--> statement-breakpoint
CREATE TABLE "usage_daily" (
	"day" date PRIMARY KEY NOT NULL,
	"live_audio_sec" integer DEFAULT 0 NOT NULL,
	"live_tokens" integer DEFAULT 0 NOT NULL,
	"extract_tokens" integer DEFAULT 0 NOT NULL,
	"extract_requests" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vocab" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"phrase" text NOT NULL,
	"example" text,
	"count" integer DEFAULT 1 NOT NULL,
	"next_review" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vocab_phrase_unique" UNIQUE("phrase")
);
--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mistakes_pattern_idx" ON "mistakes" USING btree ("pattern");--> statement-breakpoint
CREATE INDEX "sessions_search_idx" ON "sessions" USING gin ("search");--> statement-breakpoint
CREATE INDEX "sessions_started_at_idx" ON "sessions" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "turns_search_idx" ON "turns" USING gin ("search");--> statement-breakpoint
CREATE INDEX "turns_session_idx" ON "turns" USING btree ("session_id","created_at");