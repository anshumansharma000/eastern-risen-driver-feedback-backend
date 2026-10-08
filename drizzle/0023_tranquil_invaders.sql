CREATE TABLE "core"."payment_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_payment_id" text NOT NULL,
	"status" text NOT NULL,
	"raw_status" text NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"currency" text NOT NULL,
	"initiated_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"failure_code" text,
	"failure_message" text,
	"accounting_status" text DEFAULT 'UNAPPLIED' NOT NULL,
	"receipt_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_attempts_status_check" CHECK ("core"."payment_attempts"."status" IN ('NOT_ATTEMPTED','PENDING','SUCCESS','FAILED','USER_DROPPED','CANCELLED','VOID','UNKNOWN')),
	CONSTRAINT "payment_attempts_accounting_check" CHECK ("core"."payment_attempts"."accounting_status" IN ('UNAPPLIED','APPLIED','REVIEW_REQUIRED')),
	CONSTRAINT "payment_attempts_amount_check" CHECK ("core"."payment_attempts"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "core"."payment_reconciliation_jobs" (
	"order_id" uuid PRIMARY KEY NOT NULL,
	"next_check_at" timestamp with time zone,
	"revision" integer DEFAULT 0 NOT NULL,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."payment_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"event_key" text NOT NULL,
	"order_id" uuid NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core"."payment_orders" DROP CONSTRAINT "payment_orders_status_check";--> statement-breakpoint
ALTER TABLE "core"."payment_orders" ADD COLUMN "provider_status" text;--> statement-breakpoint
ALTER TABLE "core"."payment_orders" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "core"."payment_orders" ADD COLUMN "last_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "core"."payment_orders" ADD COLUMN "snapshot_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "core"."payment_orders" ADD COLUMN "review_required_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "core"."payment_attempts" ADD CONSTRAINT "payment_attempts_order_id_payment_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "core"."payment_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."payment_attempts" ADD CONSTRAINT "payment_attempts_receipt_id_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "core"."receipts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."payment_reconciliation_jobs" ADD CONSTRAINT "payment_reconciliation_jobs_order_id_payment_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "core"."payment_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."payment_webhook_events" ADD CONSTRAINT "payment_webhook_events_order_id_payment_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "core"."payment_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_attempts_provider_id_unique" ON "core"."payment_attempts" USING btree ("provider","provider_payment_id");--> statement-breakpoint
CREATE INDEX "payment_attempts_order_idx" ON "core"."payment_attempts" USING btree ("order_id","initiated_at");--> statement-breakpoint
CREATE INDEX "payment_reconciliation_due_idx" ON "core"."payment_reconciliation_jobs" USING btree ("next_check_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_webhook_events_key_unique" ON "core"."payment_webhook_events" USING btree ("provider","event_key");--> statement-breakpoint
ALTER TABLE "core"."payment_orders" ADD CONSTRAINT "payment_orders_status_check" CHECK ("core"."payment_orders"."status" IN ('CREATING','READY','PAID','EXPIRED','TERMINATED','REVIEW_REQUIRED'));
--> statement-breakpoint
-- Preserve existing successful accounting applications when introducing attempts.
INSERT INTO core.payment_attempts
  (order_id, provider, provider_payment_id, status, raw_status, amount, currency,
   initiated_at, completed_at, accounting_status, receipt_id)
SELECT id, provider, provider_payment_id, 'SUCCESS', 'SUCCESS', amount, 'INR',
  coalesce(paid_at, created_at), paid_at,
  CASE WHEN status = 'PAID' AND receipt_id IS NOT NULL THEN 'APPLIED' ELSE 'REVIEW_REQUIRED' END,
  receipt_id
FROM core.payment_orders
WHERE provider_payment_id IS NOT NULL AND status = 'PAID' AND receipt_id IS NOT NULL;
--> statement-breakpoint
-- Existing unresolved orders must be picked up automatically after deployment.
INSERT INTO core.payment_reconciliation_jobs (order_id, next_check_at)
SELECT id, now() FROM core.payment_orders;
