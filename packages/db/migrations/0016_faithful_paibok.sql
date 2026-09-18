CREATE TABLE "encrypted_credential" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"space_id" uuid NOT NULL,
	"name" text NOT NULL,
	"envelope" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "encrypted_credential_name_check" CHECK (length(btrim("encrypted_credential"."name")) > 0),
	CONSTRAINT "encrypted_credential_envelope_check" CHECK (length(btrim("encrypted_credential"."envelope")) > 0)
);
--> statement-breakpoint
ALTER TABLE "encrypted_credential" ADD CONSTRAINT "encrypted_credential_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "encrypted_credential_space_name_unique" ON "encrypted_credential" USING btree ("space_id","name");--> statement-breakpoint
CREATE INDEX "encrypted_credential_space_id_idx" ON "encrypted_credential" USING btree ("space_id");