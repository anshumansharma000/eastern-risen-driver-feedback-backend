ALTER TABLE "core"."commercial_bookings" ADD COLUMN "payment_activation" jsonb;--> statement-breakpoint
ALTER TABLE "core"."commercial_quotes" ADD COLUMN "pricing" jsonb;--> statement-breakpoint
ALTER TABLE "core"."commercial_quotes" ADD COLUMN "proposed_plan" jsonb;