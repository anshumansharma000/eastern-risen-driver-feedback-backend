CREATE TYPE "public"."booking_status" AS ENUM('ACTIVE', 'COMPLETED', 'CANCELLED', 'ARCHIVED');--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_reference" text NOT NULL,
	"passenger_name" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" "booking_status" DEFAULT 'ACTIVE' NOT NULL,
	"notes" text,
	"created_by_account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "bookings_period_check" CHECK ("bookings"."ends_at" > "bookings"."starts_at"),
	CONSTRAINT "bookings_archived_at_check" CHECK (("bookings"."status" = 'ARCHIVED' AND "bookings"."archived_at" IS NOT NULL)
          OR ("bookings"."status" <> 'ARCHIVED' AND "bookings"."archived_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "driver_licenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"driver_id" uuid NOT NULL,
	"license_number" text,
	"issued_on" date,
	"expires_on" date,
	"issuing_authority" text,
	"categories" text[],
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "driver_licenses_driver_id_unique" UNIQUE("driver_id"),
	CONSTRAINT "driver_licenses_date_range_check" CHECK ("driver_licenses"."issued_on" IS NULL OR "driver_licenses"."expires_on" IS NULL OR "driver_licenses"."expires_on" > "driver_licenses"."issued_on")
);
--> statement-breakpoint
DROP INDEX "trips_booking_reference_idx";--> statement-breakpoint
DROP INDEX "trips_booking_reference_unique";--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "booking_id" uuid;--> statement-breakpoint
INSERT INTO "bookings" (
	"booking_reference",
	"passenger_name",
	"starts_at",
	"ends_at",
	"created_by_account_id",
	"created_at",
	"updated_at"
)
SELECT
	"booking_reference",
	"passenger_name",
	"scheduled_at",
	"scheduled_end_at",
	"created_by_account_id",
	"created_at",
	"updated_at"
FROM "trips";--> statement-breakpoint
UPDATE "trips"
SET "booking_id" = "bookings"."id"
FROM "bookings"
WHERE lower("trips"."booking_reference") = lower("bookings"."booking_reference");--> statement-breakpoint
ALTER TABLE "trips" ALTER COLUMN "booking_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_created_by_account_id_auth_accounts_id_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "public"."auth_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_licenses" ADD CONSTRAINT "driver_licenses_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bookings_reference_unique" ON "bookings" USING btree (lower("booking_reference"));--> statement-breakpoint
CREATE INDEX "bookings_status_starts_idx" ON "bookings" USING btree ("status","starts_at");--> statement-breakpoint
CREATE INDEX "driver_licenses_expiry_idx" ON "driver_licenses" USING btree ("expires_on");--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trips_booking_scheduled_idx" ON "trips" USING btree ("booking_id","scheduled_at");--> statement-breakpoint
ALTER TABLE "trips" DROP COLUMN "booking_reference";--> statement-breakpoint
ALTER TABLE "trips" DROP COLUMN "passenger_name";
