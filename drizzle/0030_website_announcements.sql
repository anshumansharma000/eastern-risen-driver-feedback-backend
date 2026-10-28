CREATE TABLE "core"."website_announcements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"message" text NOT NULL,
	"link_text" text,
	"link_url" text,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"placement" text DEFAULT 'HOME' NOT NULL,
	"paths" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"priority" text DEFAULT 'NORMAL' NOT NULL,
	"dismissible" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "website_announcements_dates" CHECK ("core"."website_announcements"."ends_at" is null or "core"."website_announcements"."ends_at" > "core"."website_announcements"."starts_at"),
	CONSTRAINT "website_announcements_status" CHECK ("core"."website_announcements"."status" in ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
	CONSTRAINT "website_announcements_category" CHECK ("core"."website_announcements"."category" in ('GENERAL', 'NEW_JOURNEY', 'SEASONAL', 'TRAVEL_ADVISORY', 'SERVICE_UPDATE')),
	CONSTRAINT "website_announcements_placement" CHECK ("core"."website_announcements"."placement" in ('HOME', 'PUBLIC', 'SELECTED')),
	CONSTRAINT "website_announcements_priority" CHECK ("core"."website_announcements"."priority" in ('NORMAL', 'IMPORTANT')),
	CONSTRAINT "website_announcements_link_pair" CHECK (("core"."website_announcements"."link_text" is null) = ("core"."website_announcements"."link_url" is null))
);
--> statement-breakpoint
CREATE INDEX "website_announcements_active_idx" ON "core"."website_announcements" USING btree ("status","starts_at","ends_at");