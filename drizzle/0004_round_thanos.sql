CREATE TYPE "public"."feedback_review_state" AS ENUM('NORMAL', 'FLAGGED', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."feedback_submission_mode" AS ENUM('ONLINE', 'OFFLINE_SYNC');--> statement-breakpoint
CREATE TYPE "public"."question_category" AS ENUM('OVERALL_EXPERIENCE', 'DRIVING_SAFETY', 'PUNCTUALITY', 'CLEANLINESS', 'PROFESSIONALISM', 'VEHICLE_CONDITION', 'CUSTOM');--> statement-breakpoint
CREATE TYPE "public"."question_status" AS ENUM('ACTIVE', 'INACTIVE', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."question_type" AS ENUM('STAR_RATING', 'EMOJI_RATING', 'YES_NO', 'SINGLE_CHOICE', 'MULTIPLE_CHOICE', 'TEXT');--> statement-breakpoint
CREATE TYPE "public"."questionnaire_status" AS ENUM('ACTIVE', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."questionnaire_version_status" AS ENUM('DRAFT', 'ACTIVE', 'RETIRED', 'ARCHIVED');--> statement-breakpoint
CREATE TABLE "feedback_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"feedback_submission_id" uuid NOT NULL,
	"version_question_id" uuid NOT NULL,
	"question_stable_key" text NOT NULL,
	"question_prompt_snapshot" text NOT NULL,
	"question_type_snapshot" "question_type" NOT NULL,
	"category_snapshot" "question_category" NOT NULL,
	"display_order_snapshot" integer NOT NULL,
	"answer_payload" jsonb NOT NULL,
	"numeric_score" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_answers_submission_question_unique" UNIQUE("feedback_submission_id","version_question_id")
);
--> statement-breakpoint
CREATE TABLE "feedback_handoffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"questionnaire_version_id" uuid NOT NULL,
	"consent_version_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_handoffs_trip_id_unique" UNIQUE("trip_id")
);
--> statement-breakpoint
CREATE TABLE "feedback_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_submission_id" uuid NOT NULL,
	"trip_id" uuid NOT NULL,
	"driver_id" uuid NOT NULL,
	"driver_name_snapshot" text NOT NULL,
	"driver_source_snapshot" "driver_source_type" NOT NULL,
	"vendor_id" uuid,
	"vendor_name_snapshot" text,
	"booking_reference_snapshot" text NOT NULL,
	"respondent_name" text NOT NULL,
	"respondent_phone_ciphertext" text NOT NULL,
	"respondent_email_ciphertext" text NOT NULL,
	"respondent_booking_reference" text NOT NULL,
	"consent_version_id" uuid NOT NULL,
	"consented_at" timestamp with time zone NOT NULL,
	"questionnaire_version_id" uuid NOT NULL,
	"questionnaire_snapshot" jsonb NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submission_mode" "feedback_submission_mode" NOT NULL,
	"current_review_state" "feedback_review_state" DEFAULT 'NORMAL' NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_submissions_archive_state_check" CHECK (("feedback_submissions"."current_review_state" = 'ARCHIVED' AND "feedback_submissions"."archived_at" IS NOT NULL)
          OR ("feedback_submissions"."current_review_state" <> 'ARCHIVED' AND "feedback_submissions"."archived_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "consent_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" integer NOT NULL,
	"content" text NOT NULL,
	"effective_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	"created_by_account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consent_versions_version_unique" UNIQUE("version")
);
--> statement-breakpoint
CREATE TABLE "question_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_question_id" uuid NOT NULL,
	"value_key" text NOT NULL,
	"label" text NOT NULL,
	"score_value" double precision,
	"display_order" integer NOT NULL,
	CONSTRAINT "question_options_value_key_unique" UNIQUE("version_question_id","value_key"),
	CONSTRAINT "question_options_order_unique" UNIQUE("version_question_id","display_order"),
	CONSTRAINT "question_options_order_check" CHECK ("question_options"."display_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "questionnaire_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"questionnaire_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"status" "questionnaire_version_status" DEFAULT 'DRAFT' NOT NULL,
	"published_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_by_account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "questionnaire_versions_number_unique" UNIQUE("questionnaire_id","version_number")
);
--> statement-breakpoint
CREATE TABLE "questionnaires" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"status" "questionnaire_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_by_account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "questionnaires_archived_at_check" CHECK (("questionnaires"."status" = 'ARCHIVED' AND "questionnaires"."archived_at" IS NOT NULL)
          OR ("questionnaires"."status" = 'ACTIVE' AND "questionnaires"."archived_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "version_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"questionnaire_version_id" uuid NOT NULL,
	"stable_key" text NOT NULL,
	"prompt" text NOT NULL,
	"question_type" "question_type" NOT NULL,
	"category" "question_category" NOT NULL,
	"status" "question_status" DEFAULT 'ACTIVE' NOT NULL,
	"is_required" boolean DEFAULT false NOT NULL,
	"display_order" integer NOT NULL,
	"contributes_to_score" boolean DEFAULT false NOT NULL,
	"score_min" double precision,
	"score_max" double precision,
	CONSTRAINT "version_questions_stable_key_unique" UNIQUE("questionnaire_version_id","stable_key"),
	CONSTRAINT "version_questions_order_unique" UNIQUE("questionnaire_version_id","display_order"),
	CONSTRAINT "version_questions_order_check" CHECK ("version_questions"."display_order" >= 0),
	CONSTRAINT "version_questions_score_bounds_check" CHECK ("version_questions"."score_min" IS NULL OR "version_questions"."score_max" IS NULL OR "version_questions"."score_min" <= "version_questions"."score_max"),
	CONSTRAINT "version_questions_text_score_check" CHECK ("version_questions"."question_type" <> 'TEXT' OR "version_questions"."contributes_to_score" = false)
);
--> statement-breakpoint
ALTER TABLE "feedback_answers" ADD CONSTRAINT "feedback_answers_feedback_submission_id_feedback_submissions_id_fk" FOREIGN KEY ("feedback_submission_id") REFERENCES "public"."feedback_submissions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_answers" ADD CONSTRAINT "feedback_answers_version_question_id_version_questions_id_fk" FOREIGN KEY ("version_question_id") REFERENCES "public"."version_questions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_handoffs" ADD CONSTRAINT "feedback_handoffs_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_handoffs" ADD CONSTRAINT "feedback_handoffs_questionnaire_version_id_questionnaire_versions_id_fk" FOREIGN KEY ("questionnaire_version_id") REFERENCES "public"."questionnaire_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_handoffs" ADD CONSTRAINT "feedback_handoffs_consent_version_id_consent_versions_id_fk" FOREIGN KEY ("consent_version_id") REFERENCES "public"."consent_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_submissions" ADD CONSTRAINT "feedback_submissions_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_submissions" ADD CONSTRAINT "feedback_submissions_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_submissions" ADD CONSTRAINT "feedback_submissions_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_submissions" ADD CONSTRAINT "feedback_submissions_consent_version_id_consent_versions_id_fk" FOREIGN KEY ("consent_version_id") REFERENCES "public"."consent_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_submissions" ADD CONSTRAINT "feedback_submissions_questionnaire_version_id_questionnaire_versions_id_fk" FOREIGN KEY ("questionnaire_version_id") REFERENCES "public"."questionnaire_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_submissions" ADD CONSTRAINT "feedback_submissions_archived_by_account_id_auth_accounts_id_fk" FOREIGN KEY ("archived_by_account_id") REFERENCES "public"."auth_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_versions" ADD CONSTRAINT "consent_versions_created_by_account_id_auth_accounts_id_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "public"."auth_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_options" ADD CONSTRAINT "question_options_version_question_id_version_questions_id_fk" FOREIGN KEY ("version_question_id") REFERENCES "public"."version_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questionnaire_versions" ADD CONSTRAINT "questionnaire_versions_questionnaire_id_questionnaires_id_fk" FOREIGN KEY ("questionnaire_id") REFERENCES "public"."questionnaires"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questionnaire_versions" ADD CONSTRAINT "questionnaire_versions_created_by_account_id_auth_accounts_id_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "public"."auth_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questionnaires" ADD CONSTRAINT "questionnaires_created_by_account_id_auth_accounts_id_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "public"."auth_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "version_questions" ADD CONSTRAINT "version_questions_questionnaire_version_id_questionnaire_versions_id_fk" FOREIGN KEY ("questionnaire_version_id") REFERENCES "public"."questionnaire_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feedback_answers_submission_order_idx" ON "feedback_answers" USING btree ("feedback_submission_id","display_order_snapshot");--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_handoffs_token_hash_unique" ON "feedback_handoffs" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "feedback_handoffs_expiry_idx" ON "feedback_handoffs" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_submissions_client_id_unique" ON "feedback_submissions" USING btree ("client_submission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_submissions_trip_unique" ON "feedback_submissions" USING btree ("trip_id");--> statement-breakpoint
CREATE INDEX "feedback_submissions_driver_received_idx" ON "feedback_submissions" USING btree ("driver_id","received_at");--> statement-breakpoint
CREATE INDEX "feedback_submissions_review_received_idx" ON "feedback_submissions" USING btree ("current_review_state","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "consent_versions_active_unique" ON "consent_versions" USING btree (((1))) WHERE "consent_versions"."retired_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "questionnaire_versions_global_active_unique" ON "questionnaire_versions" USING btree (((1))) WHERE "questionnaire_versions"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "questionnaire_versions_questionnaire_status_idx" ON "questionnaire_versions" USING btree ("questionnaire_id","status");--> statement-breakpoint
CREATE INDEX "questionnaires_status_idx" ON "questionnaires" USING btree ("status");