ALTER TYPE "public"."attempt_status" ADD VALUE 'cancelled' BEFORE 'abandoned';--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "stop_requested_at" timestamp with time zone;