CREATE TYPE "public"."feedback_engagement_status" AS ENUM('READY', 'FEEDBACK_STARTED', 'SUBMITTED', 'ARCHIVED');--> statement-breakpoint
CREATE TABLE "booking_driver_engagements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"sequence_number" integer NOT NULL,
	"driver_id" uuid NOT NULL,
	"driver_name_snapshot" text NOT NULL,
	"driver_code_snapshot" text NOT NULL,
	"driver_source_snapshot" "driver_source_type" NOT NULL,
	"vendor_id" uuid,
	"vendor_name_snapshot" text,
	"status" "feedback_engagement_status" DEFAULT 'READY' NOT NULL,
	"started_feedback_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "booking_driver_engagements_sequence_check" CHECK ("booking_driver_engagements"."sequence_number" > 0),
	CONSTRAINT "booking_driver_engagements_vendor_snapshot_check" CHECK (("booking_driver_engagements"."driver_source_snapshot" = 'OUTSOURCED'
            AND "booking_driver_engagements"."vendor_id" IS NOT NULL
            AND "booking_driver_engagements"."vendor_name_snapshot" IS NOT NULL)
          OR ("booking_driver_engagements"."driver_source_snapshot" = 'AGENCY'
            AND "booking_driver_engagements"."vendor_id" IS NULL
            AND "booking_driver_engagements"."vendor_name_snapshot" IS NULL)),
	CONSTRAINT "booking_driver_engagements_feedback_started_check" CHECK (("booking_driver_engagements"."status" = 'READY' AND "booking_driver_engagements"."started_feedback_at" IS NULL)
          OR ("booking_driver_engagements"."status" IN ('FEEDBACK_STARTED', 'SUBMITTED')
            AND "booking_driver_engagements"."started_feedback_at" IS NOT NULL)
          OR ("booking_driver_engagements"."status" = 'ARCHIVED')),
	CONSTRAINT "booking_driver_engagements_archived_at_check" CHECK (("booking_driver_engagements"."status" = 'ARCHIVED' AND "booking_driver_engagements"."archived_at" IS NOT NULL)
          OR ("booking_driver_engagements"."status" <> 'ARCHIVED' AND "booking_driver_engagements"."archived_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "engagement_feedback_sections" (
	"engagement_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"purpose" "questionnaire_purpose" NOT NULL,
	"assigned_by_account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "engagement_feedback_sections_engagement_purpose_pk" PRIMARY KEY("engagement_id","purpose")
);
--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "engagement_id" uuid;--> statement-breakpoint
-- Preserve every existing trip-scoped feedback record without rewriting immutable history.
-- Existing trips become one-trip engagements; any later editable schedule mutation will
-- rebuild the booking into consecutive-driver engagements through the application service.
INSERT INTO "booking_driver_engagements" (
	"id", "booking_id", "sequence_number", "driver_id", "driver_name_snapshot",
	"driver_code_snapshot", "driver_source_snapshot", "vendor_id", "vendor_name_snapshot",
	"status", "started_feedback_at", "created_at", "updated_at", "archived_at"
)
SELECT
	"id",
	"booking_id",
	row_number() OVER (
		PARTITION BY "booking_id"
		ORDER BY "scheduled_at", "created_at", "id"
	)::integer,
	"driver_id",
	"driver_name_snapshot",
	"driver_code_snapshot",
	"driver_source_snapshot",
	"vendor_id",
	"vendor_name_snapshot",
	"status"::text::"feedback_engagement_status",
	CASE
		WHEN "status" IN ('FEEDBACK_STARTED', 'SUBMITTED')
			THEN coalesce("started_feedback_at", "updated_at")
		ELSE "started_feedback_at"
	END,
	"created_at",
	"updated_at",
	"archived_at"
FROM "trips";--> statement-breakpoint
INSERT INTO "engagement_feedback_sections" (
	"engagement_id", "booking_id", "purpose", "assigned_by_account_id", "created_at"
)
SELECT "trip_id", "booking_id", "purpose", "assigned_by_account_id", "created_at"
FROM "trip_feedback_sections";--> statement-breakpoint
UPDATE "trips" SET "engagement_id" = "id";--> statement-breakpoint
ALTER TABLE "trip_feedback_sections" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "trip_feedback_sections" CASCADE;--> statement-breakpoint
ALTER TABLE "feedback_handoffs" RENAME COLUMN "trip_id" TO "engagement_id";--> statement-breakpoint
ALTER TABLE "feedback_photos" RENAME COLUMN "trip_id" TO "engagement_id";--> statement-breakpoint
ALTER TABLE "feedback_submissions" RENAME COLUMN "trip_id" TO "engagement_id";--> statement-breakpoint
ALTER TABLE "feedback_handoffs" DROP CONSTRAINT "feedback_handoffs_trip_id_unique";--> statement-breakpoint
ALTER TABLE "feedback_handoffs" DROP CONSTRAINT "feedback_handoffs_trip_id_trips_id_fk";
--> statement-breakpoint
ALTER TABLE "feedback_photos" DROP CONSTRAINT "feedback_photos_trip_id_trips_id_fk";
--> statement-breakpoint
ALTER TABLE "feedback_submissions" DROP CONSTRAINT "feedback_submissions_trip_id_trips_id_fk";
--> statement-breakpoint
DROP INDEX "feedback_photos_trip_status_idx";--> statement-breakpoint
DROP INDEX "feedback_submissions_trip_unique";--> statement-breakpoint
ALTER TABLE "booking_driver_engagements" ADD CONSTRAINT "booking_driver_engagements_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_driver_engagements" ADD CONSTRAINT "booking_driver_engagements_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_driver_engagements" ADD CONSTRAINT "booking_driver_engagements_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_feedback_sections" ADD CONSTRAINT "engagement_feedback_sections_engagement_id_booking_driver_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."booking_driver_engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_feedback_sections" ADD CONSTRAINT "engagement_feedback_sections_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_feedback_sections" ADD CONSTRAINT "engagement_feedback_sections_assigned_by_account_id_auth_accounts_id_fk" FOREIGN KEY ("assigned_by_account_id") REFERENCES "public"."auth_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "booking_driver_engagements_booking_sequence_unique" ON "booking_driver_engagements" USING btree ("booking_id","sequence_number");--> statement-breakpoint
CREATE INDEX "booking_driver_engagements_driver_status_idx" ON "booking_driver_engagements" USING btree ("driver_id","status");--> statement-breakpoint
CREATE INDEX "engagement_feedback_sections_booking_idx" ON "engagement_feedback_sections" USING btree ("booking_id");--> statement-breakpoint
CREATE UNIQUE INDEX "engagement_feedback_sections_booking_boundary_unique" ON "engagement_feedback_sections" USING btree ("booking_id","purpose") WHERE "engagement_feedback_sections"."purpose" IN ('ARRIVAL_EXPERIENCE', 'TOUR_EXPERIENCE');--> statement-breakpoint
ALTER TABLE "feedback_handoffs" ADD CONSTRAINT "feedback_handoffs_engagement_id_booking_driver_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."booking_driver_engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_photos" ADD CONSTRAINT "feedback_photos_engagement_id_booking_driver_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."booking_driver_engagements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_submissions" ADD CONSTRAINT "feedback_submissions_engagement_id_booking_driver_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."booking_driver_engagements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_engagement_id_booking_driver_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."booking_driver_engagements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feedback_photos_engagement_status_idx" ON "feedback_photos" USING btree ("engagement_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_submissions_engagement_unique" ON "feedback_submissions" USING btree ("engagement_id");--> statement-breakpoint
ALTER TABLE "feedback_handoffs" ADD CONSTRAINT "feedback_handoffs_engagement_id_unique" UNIQUE("engagement_id");
