CREATE TABLE "usage_record" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"space_id" uuid NOT NULL,
	"bot_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"provider" text,
	"model" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_record_provider_check" CHECK ("usage_record"."provider" is null or length(btrim("usage_record"."provider")) > 0),
	CONSTRAINT "usage_record_model_check" CHECK ("usage_record"."model" is null or length(btrim("usage_record"."model")) > 0),
	CONSTRAINT "usage_record_input_tokens_check" CHECK ("usage_record"."input_tokens" is null or "usage_record"."input_tokens" >= 0),
	CONSTRAINT "usage_record_output_tokens_check" CHECK ("usage_record"."output_tokens" is null or "usage_record"."output_tokens" >= 0)
);
--> statement-breakpoint
ALTER TABLE "usage_record" ADD CONSTRAINT "usage_record_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_record" ADD CONSTRAINT "usage_record_bot_id_bot_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_record" ADD CONSTRAINT "usage_record_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "usage_record_bot_created_idx" ON "usage_record" USING btree ("bot_id","created_at");--> statement-breakpoint
CREATE INDEX "usage_record_run_id_idx" ON "usage_record" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "usage_record_space_id_idx" ON "usage_record" USING btree ("space_id");