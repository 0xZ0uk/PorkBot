CREATE TABLE "computer_snapshot" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"space_id" uuid NOT NULL,
	"bot_id" uuid NOT NULL,
	"snapshot_id" text NOT NULL,
	"storage_key" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"checksum" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "computer_snapshot_size_bytes_check" CHECK ("computer_snapshot"."size_bytes" >= 0),
	CONSTRAINT "computer_snapshot_checksum_check" CHECK ("computer_snapshot"."checksum" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "computer_snapshot" ADD CONSTRAINT "computer_snapshot_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computer_snapshot" ADD CONSTRAINT "computer_snapshot_bot_id_bot_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "computer_snapshot_space_bot_snapshot_unique" ON "computer_snapshot" USING btree ("space_id","bot_id","snapshot_id");--> statement-breakpoint
CREATE INDEX "computer_snapshot_bot_id_idx" ON "computer_snapshot" USING btree ("bot_id");--> statement-breakpoint
CREATE INDEX "computer_snapshot_space_id_idx" ON "computer_snapshot" USING btree ("space_id");