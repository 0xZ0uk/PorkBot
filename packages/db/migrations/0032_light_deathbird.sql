CREATE TABLE "message_attachment" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"space_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"bot_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"storage_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_attachment_filename_check" CHECK (length(btrim("message_attachment"."filename")) > 0),
	CONSTRAINT "message_attachment_content_type_check" CHECK (length(btrim("message_attachment"."content_type")) > 0),
	CONSTRAINT "message_attachment_size_bytes_check" CHECK ("message_attachment"."size_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "run_artifact" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"space_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"bot_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"call_id" text NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"storage_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_artifact_call_id_check" CHECK (length(btrim("run_artifact"."call_id")) > 0),
	CONSTRAINT "run_artifact_filename_check" CHECK (length(btrim("run_artifact"."filename")) > 0),
	CONSTRAINT "run_artifact_content_type_check" CHECK (length(btrim("run_artifact"."content_type")) > 0),
	CONSTRAINT "run_artifact_size_bytes_check" CHECK ("run_artifact"."size_bytes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "message_attachment" ADD CONSTRAINT "message_attachment_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachment" ADD CONSTRAINT "message_attachment_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachment" ADD CONSTRAINT "message_attachment_bot_id_bot_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachment" ADD CONSTRAINT "message_attachment_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_artifact" ADD CONSTRAINT "run_artifact_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_artifact" ADD CONSTRAINT "run_artifact_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_artifact" ADD CONSTRAINT "run_artifact_bot_id_bot_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_artifact" ADD CONSTRAINT "run_artifact_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_artifact" ADD CONSTRAINT "run_artifact_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_attachment_thread_id_idx" ON "message_attachment" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "message_attachment_space_id_idx" ON "message_attachment" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "message_attachment_bot_id_idx" ON "message_attachment" USING btree ("bot_id");--> statement-breakpoint
CREATE INDEX "message_attachment_user_id_idx" ON "message_attachment" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "run_artifact_run_call_unique" ON "run_artifact" USING btree ("run_id","call_id");--> statement-breakpoint
CREATE INDEX "run_artifact_thread_id_idx" ON "run_artifact" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "run_artifact_space_id_idx" ON "run_artifact" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "run_artifact_bot_id_idx" ON "run_artifact" USING btree ("bot_id");--> statement-breakpoint
CREATE INDEX "run_artifact_user_id_idx" ON "run_artifact" USING btree ("user_id");