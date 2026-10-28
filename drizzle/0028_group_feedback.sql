DROP INDEX "feedback_submissions_engagement_unique";--> statement-breakpoint
ALTER TABLE "feedback_handoffs" ADD COLUMN "allow_multiple_submissions" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "feedback_submissions" ADD COLUMN "respondent_phone_hash" text;--> statement-breakpoint
ALTER TABLE "feedback_submissions" ADD COLUMN "allow_multiple_submissions" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_submissions_single_engagement_unique" ON "feedback_submissions" USING btree ("engagement_id") WHERE "feedback_submissions"."allow_multiple_submissions" = false;--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_submissions_engagement_phone_unique" ON "feedback_submissions" USING btree ("engagement_id","respondent_phone_hash") WHERE "feedback_submissions"."respondent_phone_hash" is not null;--> statement-breakpoint
ALTER TABLE "feedback_submissions" ADD CONSTRAINT "feedback_submissions_group_phone_required" CHECK ("feedback_submissions"."allow_multiple_submissions" = false OR "feedback_submissions"."respondent_phone_hash" IS NOT NULL);