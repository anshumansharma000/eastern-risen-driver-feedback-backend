CREATE TYPE "public"."trip_creation_source" AS ENUM('ADMIN_ASSIGNED', 'DRIVER_ENTERED');--> statement-breakpoint
CREATE TYPE "public"."trip_status" AS ENUM('READY', 'FEEDBACK_STARTED', 'SUBMITTED', 'ARCHIVED');--> statement-breakpoint
CREATE TABLE "trips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_reference" text NOT NULL,
	"passenger_name" text NOT NULL,
	"pickup_location" text NOT NULL,
	"destination" text NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"vehicle_snapshot" jsonb NOT NULL,
	"driver_id" uuid NOT NULL,
	"driver_name_snapshot" text NOT NULL,
	"driver_code_snapshot" text NOT NULL,
	"driver_source_snapshot" "driver_source_type" NOT NULL,
	"vendor_id" uuid,
	"vendor_name_snapshot" text,
	"creation_source" "trip_creation_source" NOT NULL,
	"created_by_account_id" uuid NOT NULL,
	"status" "trip_status" DEFAULT 'READY' NOT NULL,
	"started_feedback_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "trips_vendor_snapshot_check" CHECK (("trips"."driver_source_snapshot" = 'OUTSOURCED'
            AND "trips"."vendor_id" IS NOT NULL
            AND "trips"."vendor_name_snapshot" IS NOT NULL)
          OR ("trips"."driver_source_snapshot" = 'AGENCY'
            AND "trips"."vendor_id" IS NULL
            AND "trips"."vendor_name_snapshot" IS NULL)),
	CONSTRAINT "trips_archived_at_check" CHECK (("trips"."status" = 'ARCHIVED' AND "trips"."archived_at" IS NOT NULL)
          OR ("trips"."status" <> 'ARCHIVED' AND "trips"."archived_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_created_by_account_id_auth_accounts_id_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "public"."auth_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trips_booking_reference_idx" ON "trips" USING btree ("booking_reference");--> statement-breakpoint
CREATE INDEX "trips_driver_status_scheduled_idx" ON "trips" USING btree ("driver_id","status","scheduled_at");--> statement-breakpoint
CREATE INDEX "trips_status_scheduled_idx" ON "trips" USING btree ("status","scheduled_at");