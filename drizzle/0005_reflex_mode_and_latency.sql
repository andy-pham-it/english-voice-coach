ALTER TABLE "sessions" DROP CONSTRAINT "sessions_coach_mode_check";--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "first_word_ms" integer;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_coach_mode_check" CHECK ("sessions"."coach_mode" in ('coach', 'interview', 'reflex'));