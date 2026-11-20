-- A row of a bulk import can report to someone already in the portal, not
-- only to another row of the same sheet. Without it, a blue-collar worker
-- whose manager was onboarded earlier could never be confirmed.
ALTER TABLE "bulk_import_rows" ADD COLUMN "reports_to_user_id" uuid;--> statement-breakpoint
ALTER TABLE "bulk_import_rows" ADD CONSTRAINT "bulk_import_rows_reports_to_user_id_users_id_fk" FOREIGN KEY ("reports_to_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
