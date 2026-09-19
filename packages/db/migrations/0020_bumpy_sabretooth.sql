CREATE TABLE "model_connection" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"space_id" uuid NOT NULL,
	"label" text NOT NULL,
	"base_url" text NOT NULL,
	"credential_name" text NOT NULL,
	"default_model" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_connection_label_check" CHECK (length(btrim("model_connection"."label")) > 0),
	CONSTRAINT "model_connection_credential_name_check" CHECK (length(btrim("model_connection"."credential_name")) > 0),
	CONSTRAINT "model_connection_base_url_scheme_check" CHECK ("model_connection"."base_url" ~ '^https?://'),
	CONSTRAINT "model_connection_base_url_no_credentials_check" CHECK ("model_connection"."base_url" !~ '://[^/?#]*@'),
	CONSTRAINT "model_connection_default_model_check" CHECK ("model_connection"."default_model" is null or length(btrim("model_connection"."default_model")) > 0)
);
--> statement-breakpoint
ALTER TABLE "bot" ADD COLUMN "model_connection_id" uuid;--> statement-breakpoint
ALTER TABLE "bot" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "model_connection" ADD CONSTRAINT "model_connection_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "model_connection_space_label_unique" ON "model_connection" USING btree ("space_id","label");--> statement-breakpoint
CREATE UNIQUE INDEX "model_connection_space_default_unique" ON "model_connection" USING btree ("space_id") WHERE "model_connection"."is_default";--> statement-breakpoint
CREATE INDEX "model_connection_space_id_idx" ON "model_connection" USING btree ("space_id");--> statement-breakpoint
ALTER TABLE "bot" ADD CONSTRAINT "bot_model_connection_id_model_connection_id_fk" FOREIGN KEY ("model_connection_id") REFERENCES "public"."model_connection"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bot_model_connection_id_idx" ON "bot" USING btree ("model_connection_id");--> statement-breakpoint
ALTER TABLE "bot" ADD CONSTRAINT "bot_model_check" CHECK ("bot"."model" is null or length(btrim("bot"."model")) > 0);