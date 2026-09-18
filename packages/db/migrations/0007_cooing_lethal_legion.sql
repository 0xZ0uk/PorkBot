CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'denied', 'timed_out');--> statement-breakpoint
CREATE TABLE "approval" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"space_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"call_id" text NOT NULL,
	"tool" text NOT NULL,
	"status" "approval_status" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_resolution_check" CHECK (("approval"."status" = 'pending' and "approval"."decided_at" is null and "approval"."decided_by_user_id" is null and "approval"."reason" is null)
        or ("approval"."status" in ('approved', 'denied') and "approval"."decided_at" is not null and "approval"."decided_by_user_id" is not null)
        or ("approval"."status" = 'timed_out' and "approval"."decided_at" is not null and "approval"."decided_by_user_id" is null)),
	CONSTRAINT "approval_identifiers_check" CHECK (length(btrim("approval"."call_id")) > 0 and length(btrim("approval"."tool")) > 0)
);
--> statement-breakpoint
ALTER TABLE "approval" ADD CONSTRAINT "approval_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval" ADD CONSTRAINT "approval_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval" ADD CONSTRAINT "approval_decided_by_user_id_user_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "approval_run_call_unique" ON "approval" USING btree ("run_id","call_id");--> statement-breakpoint
CREATE INDEX "approval_space_id_idx" ON "approval" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "approval_run_status_idx" ON "approval" USING btree ("run_id","status");--> statement-breakpoint
CREATE INDEX "approval_status_expires_idx" ON "approval" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "approval_decided_by_user_id_idx" ON "approval" USING btree ("decided_by_user_id");