CREATE TABLE "bot_secret" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"space_id" uuid NOT NULL,
	"bot_id" uuid NOT NULL,
	"name" text NOT NULL,
	"origin" text NOT NULL,
	"auth" jsonb NOT NULL,
	"envelope" text,
	"forgotten_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bot_secret_name_check" CHECK (length(btrim("bot_secret"."name")) > 0),
	CONSTRAINT "bot_secret_origin_check" CHECK (length(btrim("bot_secret"."origin")) > 0),
	CONSTRAINT "bot_secret_auth_type_check" CHECK ("bot_secret"."auth"->>'type' in ('bearer', 'header', 'basic'))
);
--> statement-breakpoint
ALTER TABLE "bot_secret" ADD CONSTRAINT "bot_secret_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_secret" ADD CONSTRAINT "bot_secret_bot_id_bot_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bot_secret_space_bot_name_unique" ON "bot_secret" USING btree ("space_id","bot_id","name");--> statement-breakpoint
CREATE INDEX "bot_secret_bot_id_idx" ON "bot_secret" USING btree ("bot_id");--> statement-breakpoint
CREATE INDEX "bot_secret_space_id_idx" ON "bot_secret" USING btree ("space_id");