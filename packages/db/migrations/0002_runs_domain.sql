CREATE TYPE "public"."attempt_status" AS ENUM('running', 'completed', 'failed', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."effect_status" AS ENUM('pending', 'running', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."message_role" AS ENUM('user', 'assistant');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('queued', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('queued', 'running', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "attempt" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"run_id" uuid NOT NULL,
	"fence" integer NOT NULL,
	"status" "attempt_status" NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "bot" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"space_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"color" text NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"section_id" uuid,
	"archived_at" timestamp with time zone,
	"spawn_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bot_section" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"space_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"space_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_effect" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"space_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" "effect_status" NOT NULL,
	"request" jsonb NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"thread_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"role" "message_role" NOT NULL,
	"blocks" jsonb NOT NULL,
	"run_id" uuid,
	"client_nonce" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"space_id" uuid NOT NULL,
	"bot_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "run_status" NOT NULL,
	"trigger" text NOT NULL,
	"error" text,
	"error_code" text,
	"lease_owner" text,
	"lease_fence" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"checkpoint" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"client_nonce" text NOT NULL,
	"source_message_id" uuid,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_trigger_check" CHECK ("run"."trigger" in ('message', 'routine'))
);
--> statement-breakpoint
CREATE TABLE "steering_message" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"message_id" uuid NOT NULL,
	"bot_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"run_id" uuid,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"space_id" uuid NOT NULL,
	"bot_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"prompt" text NOT NULL,
	"status" "task_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thread" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"space_id" uuid NOT NULL,
	"bot_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"next_event_seq" integer DEFAULT 0 NOT NULL,
	"next_message_seq" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attempt" ADD CONSTRAINT "attempt_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot" ADD CONSTRAINT "bot_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot" ADD CONSTRAINT "bot_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot" ADD CONSTRAINT "bot_section_id_bot_section_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."bot_section"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_section" ADD CONSTRAINT "bot_section_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_section" ADD CONSTRAINT "bot_section_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_effect" ADD CONSTRAINT "external_effect_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_effect" ADD CONSTRAINT "external_effect_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_bot_id_bot_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_source_message_id_message_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."message"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "steering_message" ADD CONSTRAINT "steering_message_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "steering_message" ADD CONSTRAINT "steering_message_bot_id_bot_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "steering_message" ADD CONSTRAINT "steering_message_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "steering_message" ADD CONSTRAINT "steering_message_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_bot_id_bot_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread" ADD CONSTRAINT "thread_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread" ADD CONSTRAINT "thread_bot_id_bot_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread" ADD CONSTRAINT "thread_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attempt_run_fence_unique" ON "attempt" USING btree ("run_id","fence");--> statement-breakpoint
CREATE UNIQUE INDEX "bot_space_spawn_key_unique" ON "bot" USING btree ("space_id","spawn_key");--> statement-breakpoint
CREATE INDEX "bot_section_id_idx" ON "bot" USING btree ("section_id");--> statement-breakpoint
CREATE INDEX "bot_user_id_idx" ON "bot" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "bot_space_user_archived_pinned_updated_idx" ON "bot" USING btree ("space_id","user_id","archived_at","pinned","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bot_section_space_user_name_unique" ON "bot_section" USING btree ("space_id","user_id","name");--> statement-breakpoint
CREATE INDEX "bot_section_user_id_idx" ON "bot_section" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "bot_section_space_user_position_idx" ON "bot_section" USING btree ("space_id","user_id","position","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "event_thread_seq_unique" ON "event" USING btree ("thread_id","seq");--> statement-breakpoint
CREATE INDEX "event_run_type_seq_idx" ON "event" USING btree ("run_id","type","seq");--> statement-breakpoint
CREATE INDEX "event_space_id_idx" ON "event" USING btree ("space_id");--> statement-breakpoint
CREATE UNIQUE INDEX "external_effect_run_idempotency_key_unique" ON "external_effect" USING btree ("run_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "external_effect_run_status_idx" ON "external_effect" USING btree ("run_id","status");--> statement-breakpoint
CREATE INDEX "external_effect_space_id_idx" ON "external_effect" USING btree ("space_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_thread_seq_unique" ON "message" USING btree ("thread_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "message_thread_client_nonce_unique" ON "message" USING btree ("thread_id","client_nonce");--> statement-breakpoint
CREATE INDEX "message_run_id_idx" ON "message" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "run_space_client_nonce_unique" ON "run" USING btree ("space_id","client_nonce");--> statement-breakpoint
CREATE INDEX "run_status_lease_expires_idx" ON "run" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "run_thread_status_created_idx" ON "run" USING btree ("thread_id","status","created_at");--> statement-breakpoint
CREATE INDEX "run_bot_id_idx" ON "run" USING btree ("bot_id");--> statement-breakpoint
CREATE INDEX "run_task_id_idx" ON "run" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "run_source_message_id_idx" ON "run" USING btree ("source_message_id");--> statement-breakpoint
CREATE INDEX "run_user_id_idx" ON "run" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "steering_message_message_bot_unique" ON "steering_message" USING btree ("message_id","bot_id");--> statement-breakpoint
CREATE INDEX "steering_message_bot_id_idx" ON "steering_message" USING btree ("bot_id");--> statement-breakpoint
CREATE INDEX "steering_message_run_id_idx" ON "steering_message" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "steering_message_user_id_idx" ON "steering_message" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "task_bot_id_idx" ON "task" USING btree ("bot_id");--> statement-breakpoint
CREATE INDEX "task_thread_id_idx" ON "task" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "task_user_id_idx" ON "task" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "task_space_bot_idx" ON "task" USING btree ("space_id","bot_id");--> statement-breakpoint
CREATE INDEX "thread_bot_id_idx" ON "thread" USING btree ("bot_id");--> statement-breakpoint
CREATE INDEX "thread_user_id_idx" ON "thread" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "thread_space_updated_idx" ON "thread" USING btree ("space_id","updated_at");