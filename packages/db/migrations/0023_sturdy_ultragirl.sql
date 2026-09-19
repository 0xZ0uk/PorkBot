ALTER TABLE "run" ADD COLUMN "last_heartbeat_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "last_progress_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "current_step" text;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "current_step_tool" text;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "stalled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_current_step_check" CHECK ("run"."current_step" is null or "run"."current_step" in ('starting', 'thinking', 'working', 'waiting'));--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_current_step_tool_check" CHECK ("run"."current_step_tool" is null or "run"."current_step" in ('working', 'waiting'));