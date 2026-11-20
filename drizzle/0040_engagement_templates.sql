-- Motion templates in the Engagement studio (after Champ Studio's template
-- format): celebrations use one, filled per person; a reel can be a template
-- played live instead of an uploaded video.
ALTER TABLE "engagement_reels" ALTER COLUMN "media_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "engagement_reels" ALTER COLUMN "media_mime" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "engagement_reels" ALTER COLUMN "byte_size" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "engagement_reels" ADD COLUMN "kind" text DEFAULT 'video' NOT NULL;--> statement-breakpoint
ALTER TABLE "engagement_reels" ADD COLUMN "motion_template" text;--> statement-breakpoint
ALTER TABLE "engagement_reels" ADD COLUMN "slot_values" jsonb;--> statement-breakpoint
ALTER TABLE "engagement_templates" ADD COLUMN "motion_template" text;--> statement-breakpoint
ALTER TABLE "engagement_templates" ADD COLUMN "slot_values" jsonb;--> statement-breakpoint
-- The three celebrations start on their matching template.
UPDATE "engagement_templates" SET "motion_template" = CASE "kind" WHEN 'birthday' THEN 'birthday-burst' WHEN 'work_anniversary' THEN 'milestone-years' ELSE 'anniversary-hearts' END WHERE "motion_template" IS NULL;
