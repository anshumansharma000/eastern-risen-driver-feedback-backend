CREATE TYPE "public"."questionnaire_purpose" AS ENUM('ARRIVAL_EXPERIENCE', 'DRIVER_FEEDBACK', 'TOUR_EXPERIENCE');--> statement-breakpoint
ALTER TYPE "public"."question_category" ADD VALUE 'ARRIVAL_EXPERIENCE' BEFORE 'CUSTOM';--> statement-breakpoint
ALTER TYPE "public"."question_category" ADD VALUE 'TOUR_EXPERIENCE' BEFORE 'CUSTOM';--> statement-breakpoint
ALTER TYPE "public"."question_category" ADD VALUE 'TOUR_COORDINATION' BEFORE 'CUSTOM';--> statement-breakpoint
CREATE TABLE "feedback_handoff_sections" (
	"handoff_id" uuid NOT NULL,
	"purpose" "questionnaire_purpose" NOT NULL,
	"questionnaire_version_id" uuid NOT NULL,
	"display_order" integer NOT NULL,
	CONSTRAINT "feedback_handoff_sections_handoff_purpose_pk" PRIMARY KEY("handoff_id","purpose"),
	CONSTRAINT "feedback_handoff_sections_handoff_order_unique" UNIQUE("handoff_id","display_order")
);
--> statement-breakpoint
CREATE TABLE "feedback_submission_sections" (
	"feedback_submission_id" uuid NOT NULL,
	"purpose" "questionnaire_purpose" NOT NULL,
	"questionnaire_version_id" uuid NOT NULL,
	"questionnaire_snapshot" jsonb NOT NULL,
	"display_order" integer NOT NULL,
	CONSTRAINT "feedback_submission_sections_submission_purpose_pk" PRIMARY KEY("feedback_submission_id","purpose"),
	CONSTRAINT "feedback_submission_sections_submission_order_unique" UNIQUE("feedback_submission_id","display_order")
);
--> statement-breakpoint
CREATE TABLE "trip_feedback_sections" (
	"trip_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"purpose" "questionnaire_purpose" NOT NULL,
	"assigned_by_account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trip_feedback_sections_trip_purpose_pk" PRIMARY KEY("trip_id","purpose")
);
--> statement-breakpoint
DROP INDEX "questionnaire_versions_global_active_unique";--> statement-breakpoint
ALTER TABLE "feedback_handoffs" ALTER COLUMN "questionnaire_version_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "feedback_submissions" ALTER COLUMN "questionnaire_version_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "feedback_answers" ADD COLUMN "questionnaire_purpose_snapshot" "questionnaire_purpose" DEFAULT 'DRIVER_FEEDBACK' NOT NULL;--> statement-breakpoint
ALTER TABLE "questionnaire_versions" ADD COLUMN "purpose" "questionnaire_purpose" DEFAULT 'DRIVER_FEEDBACK' NOT NULL;--> statement-breakpoint
ALTER TABLE "questionnaires" ADD COLUMN "purpose" "questionnaire_purpose" DEFAULT 'DRIVER_FEEDBACK' NOT NULL;--> statement-breakpoint
ALTER TABLE "feedback_handoff_sections" ADD CONSTRAINT "feedback_handoff_sections_handoff_id_feedback_handoffs_id_fk" FOREIGN KEY ("handoff_id") REFERENCES "public"."feedback_handoffs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_handoff_sections" ADD CONSTRAINT "feedback_handoff_sections_questionnaire_version_id_questionnaire_versions_id_fk" FOREIGN KEY ("questionnaire_version_id") REFERENCES "public"."questionnaire_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_submission_sections" ADD CONSTRAINT "feedback_submission_sections_feedback_submission_id_feedback_submissions_id_fk" FOREIGN KEY ("feedback_submission_id") REFERENCES "public"."feedback_submissions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_submission_sections" ADD CONSTRAINT "feedback_submission_sections_questionnaire_version_id_questionnaire_versions_id_fk" FOREIGN KEY ("questionnaire_version_id") REFERENCES "public"."questionnaire_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_feedback_sections" ADD CONSTRAINT "trip_feedback_sections_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_feedback_sections" ADD CONSTRAINT "trip_feedback_sections_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_feedback_sections" ADD CONSTRAINT "trip_feedback_sections_assigned_by_account_id_auth_accounts_id_fk" FOREIGN KEY ("assigned_by_account_id") REFERENCES "public"."auth_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
INSERT INTO "trip_feedback_sections" (
	"trip_id",
	"booking_id",
	"purpose",
	"assigned_by_account_id",
	"created_at"
)
SELECT
	"id",
	"booking_id",
	'DRIVER_FEEDBACK'::"questionnaire_purpose",
	"created_by_account_id",
	"created_at"
FROM "trips"
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "feedback_handoff_sections" (
	"handoff_id",
	"purpose",
	"questionnaire_version_id",
	"display_order"
)
SELECT
	"id",
	'DRIVER_FEEDBACK'::"questionnaire_purpose",
	"questionnaire_version_id",
	0
FROM "feedback_handoffs"
WHERE "questionnaire_version_id" IS NOT NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "feedback_submission_sections" (
	"feedback_submission_id",
	"purpose",
	"questionnaire_version_id",
	"questionnaire_snapshot",
	"display_order"
)
SELECT
	"id",
	'DRIVER_FEEDBACK'::"questionnaire_purpose",
	"questionnaire_version_id",
	"questionnaire_snapshot",
	0
FROM "feedback_submissions"
WHERE "questionnaire_version_id" IS NOT NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint
CREATE INDEX "trip_feedback_sections_booking_idx" ON "trip_feedback_sections" USING btree ("booking_id");--> statement-breakpoint
CREATE UNIQUE INDEX "trip_feedback_sections_booking_boundary_unique" ON "trip_feedback_sections" USING btree ("booking_id","purpose") WHERE "trip_feedback_sections"."purpose" IN ('ARRIVAL_EXPERIENCE', 'TOUR_EXPERIENCE');--> statement-breakpoint
CREATE UNIQUE INDEX "questionnaire_versions_purpose_active_unique" ON "questionnaire_versions" USING btree ("purpose") WHERE "questionnaire_versions"."status" = 'ACTIVE';
