-- Support teams: HR, Employee Engagement and IT (src/lib/capabilities.ts
-- SUPPORT_TEAMS). Membership adds the team's privileges and makes the person
-- a responder on its desk; each desk thread records which team it is for.
CREATE TABLE "support_team_members" (
	"team_key" text NOT NULL,
	"user_id" uuid NOT NULL,
	"added_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_team_members_team_key" CHECK ("support_team_members"."team_key" in ('hr', 'engagement', 'it'))
);
--> statement-breakpoint
ALTER TABLE "chat_channels" ADD COLUMN "desk_team" text;--> statement-breakpoint
ALTER TABLE "support_team_members" ADD CONSTRAINT "support_team_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_team_members" ADD CONSTRAINT "support_team_members_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "support_team_members_team_user" ON "support_team_members" USING btree ("team_key","user_id");--> statement-breakpoint
CREATE INDEX "support_team_members_user" ON "support_team_members" USING btree ("user_id");--> statement-breakpoint
-- Every desk so far is an Ask HR thread.
UPDATE "chat_channels" SET "desk_team" = 'hr' WHERE "kind" = 'desk' AND "desk_team" IS NULL;
