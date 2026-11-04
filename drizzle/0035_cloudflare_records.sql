CREATE TABLE "activity_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"file_id" text NOT NULL,
	"uploaded_by" text NOT NULL,
	"extracted_json" jsonb,
	"extraction_model" text,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "stored_files" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"owner_id" text,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"uploaded_by" text,
	"data" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "activity_log_created_idx" ON "activity_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "activity_log_action_idx" ON "activity_log" USING btree ("action","created_at");--> statement-breakpoint
CREATE INDEX "activity_log_actor_idx" ON "activity_log" USING btree ("actor_user_id","created_at");--> statement-breakpoint
CREATE INDEX "activity_log_target_idx" ON "activity_log" USING btree ("target_id");--> statement-breakpoint
CREATE INDEX "policy_documents_created_idx" ON "policy_documents" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "stored_files_avatar_owner_idx" ON "stored_files" USING btree ("owner_id") WHERE kind = 'avatar';--> statement-breakpoint
CREATE INDEX "stored_files_kind_idx" ON "stored_files" USING btree ("kind");