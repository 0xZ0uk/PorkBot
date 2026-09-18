CREATE TYPE "public"."memory_kind" AS ENUM('fact', 'preference', 'decision');--> statement-breakpoint
CREATE TYPE "public"."memory_write_origin" AS ENUM('deliberate', 'agent_proposed');--> statement-breakpoint
CREATE TABLE "memory_document" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"space_id" uuid NOT NULL,
	"bot_id" uuid NOT NULL,
	"document_id" text NOT NULL,
	"kind" "memory_kind" NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"revision" integer NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_document_revision_check" CHECK ("memory_document"."revision" >= 1),
	CONSTRAINT "memory_document_content_check" CHECK (length(btrim("memory_document"."title")) > 0 and length(btrim("memory_document"."content")) > 0)
);
--> statement-breakpoint
CREATE TABLE "memory_revision" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"space_id" uuid NOT NULL,
	"bot_id" uuid NOT NULL,
	"document_id" text NOT NULL,
	"revision" integer NOT NULL,
	"origin" "memory_write_origin" NOT NULL,
	"author" text NOT NULL,
	"reason" text NOT NULL,
	"kind" "memory_kind" NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"deleted" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_revision_revision_check" CHECK ("memory_revision"."revision" >= 1),
	CONSTRAINT "memory_revision_record_check" CHECK (length(btrim("memory_revision"."author")) > 0 and length(btrim("memory_revision"."reason")) > 0)
);
--> statement-breakpoint
ALTER TABLE "memory_document" ADD CONSTRAINT "memory_document_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_document" ADD CONSTRAINT "memory_document_bot_id_bot_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_revision" ADD CONSTRAINT "memory_revision_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_revision" ADD CONSTRAINT "memory_revision_bot_id_bot_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_document_bot_document_unique" ON "memory_document" USING btree ("bot_id","document_id");--> statement-breakpoint
CREATE INDEX "memory_document_space_bot_live_idx" ON "memory_document" USING btree ("space_id","bot_id","deleted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_revision_bot_document_revision_unique" ON "memory_revision" USING btree ("bot_id","document_id","revision");--> statement-breakpoint
CREATE INDEX "memory_revision_space_id_idx" ON "memory_revision" USING btree ("space_id");