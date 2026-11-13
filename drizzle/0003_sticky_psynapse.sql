ALTER TABLE "mistakes" ADD COLUMN "streak" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "vocab" ADD COLUMN "streak" integer DEFAULT 0 NOT NULL;