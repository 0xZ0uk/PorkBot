CREATE TABLE "routine" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"space_id" uuid NOT NULL,
	"bot_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"instruction" text NOT NULL,
	"cron" text NOT NULL,
	"timezone" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routine_identifiers_check" CHECK (length(btrim("routine"."instruction")) > 0 and length(btrim("routine"."cron")) > 0 and length(btrim("routine"."timezone")) > 0)
);
--> statement-breakpoint
CREATE TABLE "routine_occurrence" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"routine_id" uuid NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "routine" ADD CONSTRAINT "routine_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine" ADD CONSTRAINT "routine_bot_id_bot_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine" ADD CONSTRAINT "routine_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine" ADD CONSTRAINT "routine_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_occurrence" ADD CONSTRAINT "routine_occurrence_routine_id_routine_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routine"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_occurrence" ADD CONSTRAINT "routine_occurrence_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "routine_space_bot_idx" ON "routine" USING btree ("space_id","bot_id");--> statement-breakpoint
CREATE INDEX "routine_bot_id_idx" ON "routine" USING btree ("bot_id");--> statement-breakpoint
CREATE INDEX "routine_user_id_idx" ON "routine" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "routine_thread_id_idx" ON "routine" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "routine_due_idx" ON "routine" USING btree ("next_run_at") WHERE enabled and deleted_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "routine_occurrence_routine_scheduled_unique" ON "routine_occurrence" USING btree ("routine_id","scheduled_for");--> statement-breakpoint
CREATE INDEX "routine_occurrence_run_id_idx" ON "routine_occurrence" USING btree ("run_id");