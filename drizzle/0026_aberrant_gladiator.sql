CREATE TABLE "core"."payment_attempt_resolutions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"action" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"note" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"receipt_id" uuid,
	"provider" text NOT NULL,
	"provider_refund_reference" text,
	"amount" numeric(18, 2) NOT NULL,
	"currency" text NOT NULL,
	"refund" jsonb,
	"before" jsonb NOT NULL,
	"after" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_resolution_action_check" CHECK ("core"."payment_attempt_resolutions"."action" IN ('APPLY_TO_LINKED_INVOICE','LINK_EXISTING_RECEIPT','RECORD_VERIFIED_EXTERNAL_REFUND')),
	CONSTRAINT "payment_resolution_positive_check" CHECK ("core"."payment_attempt_resolutions"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "core"."payment_attempts" DROP CONSTRAINT "payment_attempts_accounting_check";--> statement-breakpoint
ALTER TABLE "core"."payment_orders" DROP CONSTRAINT "payment_orders_status_check";--> statement-breakpoint
ALTER TABLE "core"."payment_attempts" ADD COLUMN "review_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."payment_attempt_resolutions" ADD CONSTRAINT "payment_attempt_resolutions_attempt_id_payment_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "core"."payment_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."payment_attempt_resolutions" ADD CONSTRAINT "payment_attempt_resolutions_order_id_payment_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "core"."payment_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."payment_attempt_resolutions" ADD CONSTRAINT "payment_attempt_resolutions_receipt_id_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "core"."receipts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_resolution_attempt_unique" ON "core"."payment_attempt_resolutions" USING btree ("attempt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_resolution_idempotency_unique" ON "core"."payment_attempt_resolutions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_resolution_refund_unique" ON "core"."payment_attempt_resolutions" USING btree ("provider","provider_refund_reference");--> statement-breakpoint
CREATE INDEX "payment_resolution_order_idx" ON "core"."payment_attempt_resolutions" USING btree ("order_id","created_at");--> statement-breakpoint
ALTER TABLE "core"."payment_attempts" ADD CONSTRAINT "payment_attempts_accounting_check" CHECK ("core"."payment_attempts"."accounting_status" IN ('UNAPPLIED','APPLIED','REVIEW_REQUIRED','REFUNDED'));--> statement-breakpoint
ALTER TABLE "core"."payment_orders" ADD CONSTRAINT "payment_orders_status_check" CHECK ("core"."payment_orders"."status" IN ('CREATING','READY','PAID','EXPIRED','TERMINATED','REVIEW_REQUIRED','REFUNDED'));
--> statement-breakpoint
UPDATE core.payment_attempts
SET review_reasons = '[{"code":"UNKNOWN_LEGACY_REASON","details":{}}]'::jsonb
WHERE accounting_status = 'REVIEW_REQUIRED' AND review_reasons = '[]'::jsonb;
--> statement-breakpoint
CREATE FUNCTION core.prevent_payment_resolution_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Payment resolutions are immutable' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER payment_resolution_immutable
BEFORE UPDATE OR DELETE ON core.payment_attempt_resolutions
FOR EACH ROW EXECUTE FUNCTION core.prevent_payment_resolution_mutation();
