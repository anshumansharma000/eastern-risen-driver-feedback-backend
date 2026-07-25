CREATE TABLE "driver_leave_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"driver_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "driver_leave_periods_range_check" CHECK ("driver_leave_periods"."ends_at" > "driver_leave_periods"."starts_at")
);
--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN "assignment_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN "shift_start_time" time;--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN "shift_end_time" time;--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN "time_zone" text DEFAULT 'Asia/Kolkata' NOT NULL;--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN "max_daily_duty_minutes" integer DEFAULT 720 NOT NULL;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "scheduled_end_at" timestamp with time zone;--> statement-breakpoint
UPDATE "trips" SET "scheduled_end_at" = "scheduled_at" + interval '1 hour'
WHERE "scheduled_end_at" IS NULL;--> statement-breakpoint
ALTER TABLE "trips" ALTER COLUMN "scheduled_end_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "driver_leave_periods" ADD CONSTRAINT "driver_leave_periods_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "driver_leave_periods_driver_time_idx" ON "driver_leave_periods" USING btree ("driver_id","starts_at","ends_at");--> statement-breakpoint
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_shift_pair_check" CHECK (("drivers"."shift_start_time" IS NULL AND "drivers"."shift_end_time" IS NULL)
          OR ("drivers"."shift_start_time" IS NOT NULL AND "drivers"."shift_end_time" IS NOT NULL
              AND "drivers"."shift_start_time" <> "drivers"."shift_end_time"));--> statement-breakpoint
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_max_daily_duty_minutes_check" CHECK ("drivers"."max_daily_duty_minutes" BETWEEN 1 AND 1440);--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_schedule_range_check" CHECK ("trips"."scheduled_end_at" > "trips"."scheduled_at");
