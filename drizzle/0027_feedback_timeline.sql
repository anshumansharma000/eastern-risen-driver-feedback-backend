CREATE TABLE "feedback_driver_booking_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"driver_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"token_ciphertext" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_by_account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback_driver_link_trips" (
	"link_id" uuid NOT NULL,
	"trip_id" uuid NOT NULL,
	"assignment_version" integer NOT NULL,
	CONSTRAINT "feedback_driver_link_trips_link_id_trip_id_pk" PRIMARY KEY("link_id","trip_id")
);
--> statement-breakpoint
CREATE TABLE "feedback_timeline_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_event_id" uuid NOT NULL,
	"payload_hash" text NOT NULL,
	"booking_id" uuid NOT NULL,
	"trip_id" uuid NOT NULL,
	"driver_id" uuid NOT NULL,
	"driver_name_snapshot" text NOT NULL,
	"assignment_version" integer NOT NULL,
	"actor_account_id" uuid,
	"link_id" uuid,
	"type" text NOT NULL,
	"note" text,
	"location" jsonb,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submission_mode" text NOT NULL,
	"corrects_event_id" uuid,
	"correction_reason" text,
	CONSTRAINT "feedback_timeline_events_submission_check" CHECK ("feedback_timeline_events"."submission_mode" in ('ONLINE','OFFLINE_SYNC')),
	CONSTRAINT "feedback_timeline_events_type_check" CHECK ("feedback_timeline_events"."type" in ('TRIP_STARTED','PASSENGER_PICKED_UP','ARRIVED','DROPPED_OFF','TRIP_COMPLETED','NOTE','DELAY','CORRECTION')),
	CONSTRAINT "feedback_timeline_events_actor_check" CHECK (("feedback_timeline_events"."actor_account_id" is not null and "feedback_timeline_events"."link_id" is null) or ("feedback_timeline_events"."actor_account_id" is null and "feedback_timeline_events"."link_id" is not null)),
	CONSTRAINT "feedback_timeline_events_correction_check" CHECK (("feedback_timeline_events"."type" = 'CORRECTION' and "feedback_timeline_events"."corrects_event_id" is not null and "feedback_timeline_events"."correction_reason" is not null) or ("feedback_timeline_events"."type" <> 'CORRECTION' and "feedback_timeline_events"."corrects_event_id" is null and "feedback_timeline_events"."correction_reason" is null))
);
--> statement-breakpoint
CREATE TABLE "feedback_timeline_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"driver_id" uuid NOT NULL,
	"assignment_version" integer NOT NULL,
	"event_id" uuid,
	"upload_object_key" text NOT NULL,
	"object_key" text NOT NULL,
	"content_type" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"byte_size" integer,
	"upload_expires_at" timestamp with time zone NOT NULL,
	"temporary_object_cleaned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "feedback_timeline_photos_state_check" CHECK (("feedback_timeline_photos"."status" in ('PENDING','REJECTED') and "feedback_timeline_photos"."event_id" is null) or ("feedback_timeline_photos"."status" = 'READY' and "feedback_timeline_photos"."completed_at" is not null and "feedback_timeline_photos"."event_id" is null) or ("feedback_timeline_photos"."status" = 'ATTACHED' and "feedback_timeline_photos"."completed_at" is not null and "feedback_timeline_photos"."event_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "feedback_trip_progress" (
	"trip_id" uuid PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'UNKNOWN' NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_trip_progress_status_check" CHECK ("feedback_trip_progress"."status" in ('UNKNOWN','SCHEDULED','IN_PROGRESS','COMPLETED','CANCELLED'))
);
--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "assignment_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "feedback_driver_booking_links" ADD CONSTRAINT "feedback_driver_booking_links_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_driver_booking_links" ADD CONSTRAINT "feedback_driver_booking_links_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_driver_booking_links" ADD CONSTRAINT "feedback_driver_booking_links_created_by_account_id_auth_accounts_id_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "public"."auth_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_driver_link_trips" ADD CONSTRAINT "feedback_driver_link_trips_link_id_feedback_driver_booking_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."feedback_driver_booking_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_driver_link_trips" ADD CONSTRAINT "feedback_driver_link_trips_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_timeline_events" ADD CONSTRAINT "feedback_timeline_events_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_timeline_events" ADD CONSTRAINT "feedback_timeline_events_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_timeline_events" ADD CONSTRAINT "feedback_timeline_events_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_timeline_events" ADD CONSTRAINT "feedback_timeline_events_actor_account_id_auth_accounts_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "public"."auth_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_timeline_events" ADD CONSTRAINT "feedback_timeline_events_link_id_feedback_driver_booking_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."feedback_driver_booking_links"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_timeline_events" ADD CONSTRAINT "feedback_timeline_events_corrects_event_id_feedback_timeline_events_id_fk" FOREIGN KEY ("corrects_event_id") REFERENCES "public"."feedback_timeline_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_timeline_photos" ADD CONSTRAINT "feedback_timeline_photos_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_timeline_photos" ADD CONSTRAINT "feedback_timeline_photos_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_timeline_photos" ADD CONSTRAINT "feedback_timeline_photos_event_id_feedback_timeline_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."feedback_timeline_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_trip_progress" ADD CONSTRAINT "feedback_trip_progress_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_driver_booking_links_token_unique" ON "feedback_driver_booking_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "feedback_driver_booking_links_pair_idx" ON "feedback_driver_booking_links" USING btree ("booking_id","driver_id");--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_timeline_events_client_unique" ON "feedback_timeline_events" USING btree ("client_event_id");--> statement-breakpoint
CREATE INDEX "feedback_timeline_events_booking_time_idx" ON "feedback_timeline_events" USING btree ("booking_id","occurred_at","received_at");--> statement-breakpoint
CREATE INDEX "feedback_timeline_events_trip_idx" ON "feedback_timeline_events" USING btree ("trip_id");--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_timeline_photos_upload_key_unique" ON "feedback_timeline_photos" USING btree ("upload_object_key");--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_timeline_photos_stored_key_unique" ON "feedback_timeline_photos" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "feedback_timeline_photos_event_idx" ON "feedback_timeline_photos" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "feedback_timeline_photos_cleanup_idx" ON "feedback_timeline_photos" USING btree ("created_at","status");--> statement-breakpoint
-- Legacy feedback status cannot establish whether a trip actually ran.
INSERT INTO "feedback_trip_progress" ("trip_id", "status") SELECT "id", 'UNKNOWN' FROM "trips" ON CONFLICT DO NOTHING;
