-- Alumni: everyone who has left, from the left-employee tracker HR uploads in
-- Admin Controls › Alumni (src/lib/server/alumni.ts), and each upload.
CREATE TABLE "alumni" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_code" text,
	"full_name" text NOT NULL,
	"official_email" text,
	"personal_email" text,
	"phone" text,
	"designation" text,
	"team" text,
	"department" text,
	"company" text,
	"date_of_joining" date,
	"resignation_date" date,
	"last_working_day" date,
	"nature_of_exit" text,
	"reason" text,
	"remarks" text,
	"rehire_eligible" text,
	"fnf_status" text,
	"user_id" uuid,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"import_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alumni_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"filename" text NOT NULL,
	"sheet_name" text,
	"row_count" integer DEFAULT 0 NOT NULL,
	"created_count" integer DEFAULT 0 NOT NULL,
	"updated_count" integer DEFAULT 0 NOT NULL,
	"matched_count" integer DEFAULT 0 NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alumni" ADD CONSTRAINT "alumni_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alumni" ADD CONSTRAINT "alumni_import_id_alumni_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."alumni_imports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alumni_imports" ADD CONSTRAINT "alumni_imports_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alumni_employee_code" ON "alumni" USING btree ("employee_code") WHERE "alumni"."employee_code" is not null;--> statement-breakpoint
CREATE INDEX "alumni_user" ON "alumni" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "alumni_last_working_day" ON "alumni" USING btree ("last_working_day");