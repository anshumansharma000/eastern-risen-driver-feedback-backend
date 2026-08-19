CREATE TYPE "public"."feedback_photo_status" AS ENUM('PENDING', 'PROCESSING', 'READY', 'ATTACHED', 'REJECTED');--> statement-breakpoint
CREATE TABLE "feedback_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"feedback_submission_id" uuid,
	"upload_object_key" text NOT NULL,
	"object_key" text NOT NULL,
	"status" "feedback_photo_status" DEFAULT 'PENDING' NOT NULL,
	"declared_content_type" text NOT NULL,
	"stored_content_type" text,
	"byte_size" integer,
	"upload_expires_at" timestamp with time zone NOT NULL,
	"temporary_object_cleaned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"attached_at" timestamp with time zone,
	CONSTRAINT "feedback_photos_state_check" CHECK (("feedback_photos"."status" IN ('PENDING', 'PROCESSING') AND "feedback_photos"."completed_at" IS NULL AND "feedback_photos"."attached_at" IS NULL AND "feedback_photos"."feedback_submission_id" IS NULL)
          OR ("feedback_photos"."status" = 'READY' AND "feedback_photos"."completed_at" IS NOT NULL AND "feedback_photos"."attached_at" IS NULL AND "feedback_photos"."feedback_submission_id" IS NULL)
          OR ("feedback_photos"."status" = 'ATTACHED' AND "feedback_photos"."completed_at" IS NOT NULL AND "feedback_photos"."attached_at" IS NOT NULL AND "feedback_photos"."feedback_submission_id" IS NOT NULL)
          OR ("feedback_photos"."status" = 'REJECTED' AND "feedback_photos"."attached_at" IS NULL AND "feedback_photos"."feedback_submission_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "feedback_photos" ADD CONSTRAINT "feedback_photos_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_photos" ADD CONSTRAINT "feedback_photos_feedback_submission_id_feedback_submissions_id_fk" FOREIGN KEY ("feedback_submission_id") REFERENCES "public"."feedback_submissions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_photos_upload_object_key_unique" ON "feedback_photos" USING btree ("upload_object_key");--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_photos_object_key_unique" ON "feedback_photos" USING btree ("object_key");--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_photos_submission_unique" ON "feedback_photos" USING btree ("feedback_submission_id");--> statement-breakpoint
CREATE INDEX "feedback_photos_trip_status_idx" ON "feedback_photos" USING btree ("trip_id","status");--> statement-breakpoint
CREATE INDEX "feedback_photos_status_created_idx" ON "feedback_photos" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "feedback_photos_upload_cleanup_idx" ON "feedback_photos" USING btree ("upload_expires_at","temporary_object_cleaned_at");