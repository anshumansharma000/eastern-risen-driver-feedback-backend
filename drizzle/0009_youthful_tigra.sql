CREATE TYPE "public"."feedback_review_action" AS ENUM('FLAG', 'UNFLAG', 'ARCHIVE');--> statement-breakpoint
CREATE TABLE "feedback_review_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"feedback_submission_id" uuid NOT NULL,
	"action" "feedback_review_action" NOT NULL,
	"reason" text,
	"performed_by_account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agency_settings" ADD COLUMN "negative_feedback_threshold" double precision;--> statement-breakpoint
INSERT INTO "agency_settings" ("agency_name", "timezone", "default_thank_you_message")
VALUES ('Eastern Risen', 'Asia/Kolkata', 'Thank you for your feedback.')
ON CONFLICT ("singleton_key") DO NOTHING;--> statement-breakpoint
ALTER TABLE "feedback_review_events" ADD CONSTRAINT "feedback_review_events_feedback_submission_id_feedback_submissions_id_fk" FOREIGN KEY ("feedback_submission_id") REFERENCES "public"."feedback_submissions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_review_events" ADD CONSTRAINT "feedback_review_events_performed_by_account_id_auth_accounts_id_fk" FOREIGN KEY ("performed_by_account_id") REFERENCES "public"."auth_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feedback_review_events_submission_created_idx" ON "feedback_review_events" USING btree ("feedback_submission_id","created_at");--> statement-breakpoint
CREATE INDEX "feedback_answers_category_score_idx" ON "feedback_answers" USING btree ("category_snapshot","numeric_score");--> statement-breakpoint
ALTER TABLE "agency_settings" ADD CONSTRAINT "agency_settings_negative_threshold_check" CHECK ("agency_settings"."negative_feedback_threshold" IS NULL
          OR "agency_settings"."negative_feedback_threshold" BETWEEN 1 AND 5);
