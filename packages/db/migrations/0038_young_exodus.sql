CREATE TYPE "public"."backup_alert_kind" AS ENUM('backup.missed', 'backup.failed', 'backup.stalled', 'drill.missed', 'drill.failed');--> statement-breakpoint
CREATE TYPE "public"."backup_status" AS ENUM('running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "backup_alert" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"kind" "backup_alert_kind" NOT NULL,
	"episode" text NOT NULL,
	"alerted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backup_canary" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"token" uuid NOT NULL,
	"written_at" timestamp with time zone DEFAULT now() NOT NULL,
	"singleton" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backup_canary_singleton_check" CHECK ("backup_canary"."singleton")
);
--> statement-breakpoint
CREATE TABLE "backup_run" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"status" "backup_status" DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"canary_token" uuid NOT NULL,
	"postgres_key" text,
	"postgres_size" bigint,
	"postgres_checksum" text,
	"homes_count" integer DEFAULT 0 NOT NULL,
	"homes_bytes" bigint DEFAULT 0 NOT NULL,
	"pruned_objects" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"drill_status" "backup_status",
	"drill_started_at" timestamp with time zone,
	"drill_finished_at" timestamp with time zone,
	"drill_canary_verified" boolean DEFAULT false NOT NULL,
	"drill_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backup_run_settled_check" CHECK (("backup_run"."status" = 'running') = ("backup_run"."finished_at" is null)),
	CONSTRAINT "backup_run_error_code_check" CHECK ("backup_run"."error_code" is null or "backup_run"."status" = 'failed'),
	CONSTRAINT "backup_run_postgres_size_check" CHECK ("backup_run"."postgres_size" is null or "backup_run"."postgres_size" >= 0),
	CONSTRAINT "backup_run_homes_check" CHECK ("backup_run"."homes_count" >= 0 and "backup_run"."homes_bytes" >= 0),
	CONSTRAINT "backup_run_pruned_check" CHECK ("backup_run"."pruned_objects" >= 0),
	CONSTRAINT "backup_run_drill_started_check" CHECK (("backup_run"."drill_status" is null) = ("backup_run"."drill_started_at" is null)),
	CONSTRAINT "backup_run_drill_settled_check" CHECK ("backup_run"."drill_status" is null or ("backup_run"."drill_status" = 'running') = ("backup_run"."drill_finished_at" is null)),
	CONSTRAINT "backup_run_drill_canary_check" CHECK (not "backup_run"."drill_canary_verified" or "backup_run"."drill_status" = 'succeeded'),
	CONSTRAINT "backup_run_drill_error_code_check" CHECK ("backup_run"."drill_error_code" is null or "backup_run"."drill_status" = 'failed')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "backup_alert_kind_idx" ON "backup_alert" USING btree ("kind");--> statement-breakpoint
CREATE UNIQUE INDEX "backup_canary_singleton_idx" ON "backup_canary" USING btree ("singleton");--> statement-breakpoint
CREATE INDEX "backup_run_started_at_idx" ON "backup_run" USING btree ("started_at");