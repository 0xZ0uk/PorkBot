ALTER TABLE "bot" ADD COLUMN "avatar_key" text;--> statement-breakpoint
ALTER TABLE "bot" ADD COLUMN "computer_id" uuid;--> statement-breakpoint
CREATE INDEX "bot_computer_id_idx" ON "bot" USING btree ("computer_id");