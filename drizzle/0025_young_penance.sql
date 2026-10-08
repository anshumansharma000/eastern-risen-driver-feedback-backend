CREATE INDEX "payment_orders_receipt_idx" ON "core"."payment_orders" USING btree ("receipt_id");
--> statement-breakpoint
CREATE INDEX "payment_attempts_receipt_idx" ON "core"."payment_attempts" USING btree ("receipt_id");
