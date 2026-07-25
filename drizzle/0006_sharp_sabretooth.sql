ALTER TABLE "auth_sessions" ADD COLUMN "previous_token_hash" text;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD COLUMN "previous_token_valid_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD COLUMN "absolute_expires_at" timestamp with time zone;--> statement-breakpoint
UPDATE "auth_sessions" SET "absolute_expires_at" = "created_at" + interval '30 days';--> statement-breakpoint
ALTER TABLE "auth_sessions" ALTER COLUMN "absolute_expires_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD COLUMN "rotated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_sessions_previous_token_hash_unique" ON "auth_sessions" USING btree ("previous_token_hash");--> statement-breakpoint
CREATE INDEX "auth_sessions_absolute_expiry_idx" ON "auth_sessions" USING btree ("absolute_expires_at");
