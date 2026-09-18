CREATE TABLE "oauth_state" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"state_hash" text NOT NULL,
	"space_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_delivery" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"source" text NOT NULL,
	"delivery_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "oauth_state" ADD CONSTRAINT "oauth_state_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_state" ADD CONSTRAINT "oauth_state_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_state_state_hash_unique" ON "oauth_state" USING btree ("state_hash");--> statement-breakpoint
CREATE INDEX "oauth_state_space_id_idx" ON "oauth_state" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "oauth_state_user_id_idx" ON "oauth_state" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oauth_state_expires_at_idx" ON "oauth_state" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_delivery_source_delivery_unique" ON "webhook_delivery" USING btree ("source","delivery_id");--> statement-breakpoint
CREATE INDEX "webhook_delivery_expires_at_idx" ON "webhook_delivery" USING btree ("expires_at");