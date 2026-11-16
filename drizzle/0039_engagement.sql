-- Engagement studio: celebration templates (shown by the portal on the day),
-- per-person overrides, short reels for the Home page, and who watched what.
-- Video bytes are in MongoDB GridFS (bucket engagement_media).
CREATE TABLE "engagement_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"user_id" uuid NOT NULL,
	"on_date" date NOT NULL,
	"message" text,
	"hidden" boolean DEFAULT false NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "engagement_reels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"caption" text DEFAULT '' NOT NULL,
	"media_id" text NOT NULL,
	"media_mime" text NOT NULL,
	"byte_size" integer NOT NULL,
	"duration_sec" numeric(6, 2),
	"starts_on" date,
	"ends_on" date,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "engagement_templates" (
	"kind" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"headline" text NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"theme" text DEFAULT 'confetti' NOT NULL,
	"media_id" text,
	"media_mime" text,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "engagement_templates_kind" CHECK ("engagement_templates"."kind" in ('birthday', 'work_anniversary', 'wedding_anniversary'))
);
--> statement-breakpoint
CREATE TABLE "engagement_views" (
	"item_key" text NOT NULL,
	"user_id" uuid NOT NULL,
	"day" date NOT NULL
);
--> statement-breakpoint
ALTER TABLE "engagement_overrides" ADD CONSTRAINT "engagement_overrides_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_overrides" ADD CONSTRAINT "engagement_overrides_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_reels" ADD CONSTRAINT "engagement_reels_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_templates" ADD CONSTRAINT "engagement_templates_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_views" ADD CONSTRAINT "engagement_views_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "engagement_overrides_once" ON "engagement_overrides" USING btree ("kind","user_id","on_date");--> statement-breakpoint
CREATE UNIQUE INDEX "engagement_views_once" ON "engagement_views" USING btree ("item_key","user_id","day");--> statement-breakpoint
CREATE INDEX "engagement_views_day" ON "engagement_views" USING btree ("day");--> statement-breakpoint
-- The three celebrations, switched on with words the Engagement team can change.
INSERT INTO "engagement_templates" ("kind", "headline", "message", "theme") VALUES
	('birthday', 'Happy birthday, {first_name}!', 'Wishing you a wonderful year ahead, from all of us at Champions.', 'confetti'),
	('work_anniversary', '{years} {years_word} at Champions, {first_name}!', 'Thank you for everything you bring to {team}. Here''s to many more.', 'stars'),
	('wedding_anniversary', 'Happy anniversary, {first_name}!', 'Wishing you and your family a lovely day together.', 'hearts')
ON CONFLICT ("kind") DO NOTHING;
