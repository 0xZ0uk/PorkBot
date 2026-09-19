CREATE TYPE "public"."mcp_server_auth" AS ENUM('none', 'oauth');--> statement-breakpoint
CREATE TYPE "public"."mcp_server_status" AS ENUM('pending_authorization', 'ready', 'error');--> statement-breakpoint
CREATE TABLE "bot_mcp_server" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"space_id" uuid NOT NULL,
	"bot_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_server" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"space_id" uuid NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"auth" "mcp_server_auth" NOT NULL,
	"status" "mcp_server_status" NOT NULL,
	"credential_name" text NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_server_name_check" CHECK (length(btrim("mcp_server"."name")) > 0),
	CONSTRAINT "mcp_server_url_check" CHECK (length(btrim("mcp_server"."url")) > 0),
	CONSTRAINT "mcp_server_credential_name_check" CHECK (length(btrim("mcp_server"."credential_name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "mcp_server_tool" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"space_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"parameters" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_server_tool_name_check" CHECK (length(btrim("mcp_server_tool"."name")) > 0)
);
--> statement-breakpoint
ALTER TABLE "bot_mcp_server" ADD CONSTRAINT "bot_mcp_server_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_mcp_server" ADD CONSTRAINT "bot_mcp_server_bot_id_bot_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_mcp_server" ADD CONSTRAINT "bot_mcp_server_server_id_mcp_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."mcp_server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_server" ADD CONSTRAINT "mcp_server_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_server_tool" ADD CONSTRAINT "mcp_server_tool_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_server_tool" ADD CONSTRAINT "mcp_server_tool_server_id_mcp_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."mcp_server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bot_mcp_server_space_bot_server_unique" ON "bot_mcp_server" USING btree ("space_id","bot_id","server_id");--> statement-breakpoint
CREATE INDEX "bot_mcp_server_bot_id_idx" ON "bot_mcp_server" USING btree ("bot_id");--> statement-breakpoint
CREATE INDEX "bot_mcp_server_server_id_idx" ON "bot_mcp_server" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "bot_mcp_server_space_id_idx" ON "bot_mcp_server" USING btree ("space_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_server_space_name_unique" ON "mcp_server" USING btree ("space_id","name");--> statement-breakpoint
CREATE INDEX "mcp_server_space_id_idx" ON "mcp_server" USING btree ("space_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_server_tool_server_name_unique" ON "mcp_server_tool" USING btree ("server_id","name");--> statement-breakpoint
CREATE INDEX "mcp_server_tool_server_id_idx" ON "mcp_server_tool" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "mcp_server_tool_space_id_idx" ON "mcp_server_tool" USING btree ("space_id");