CREATE TABLE "computer_lease" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"space_id" uuid NOT NULL,
	"bot_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"owner" text NOT NULL,
	"fence" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "computer_lease_owner_check" CHECK (length(btrim("computer_lease"."owner")) > 0),
	CONSTRAINT "computer_lease_fence_check" CHECK ("computer_lease"."fence" >= 0)
);
--> statement-breakpoint
ALTER TABLE "computer_lease" ADD CONSTRAINT "computer_lease_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computer_lease" ADD CONSTRAINT "computer_lease_bot_id_bot_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computer_lease" ADD CONSTRAINT "computer_lease_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "computer_lease_bot_id_unique" ON "computer_lease" USING btree ("bot_id");--> statement-breakpoint
CREATE INDEX "computer_lease_space_id_idx" ON "computer_lease" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "computer_lease_run_id_idx" ON "computer_lease" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "computer_lease_expires_at_idx" ON "computer_lease" USING btree ("expires_at");