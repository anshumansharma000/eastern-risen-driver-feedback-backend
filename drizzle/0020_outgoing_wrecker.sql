CREATE INDEX "core_audit_created_idx" ON "core"."audit_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "core_audit_actor_created_idx" ON "core"."audit_events" USING btree ("actor_id","created_at");--> statement-breakpoint
CREATE INDEX "line_taxes_component_rate_idx" ON "core"."invoice_line_taxes" USING btree ("component","rate");--> statement-breakpoint
CREATE INDEX "invoices_company_date_idx" ON "core"."invoices" USING btree ("company_id","invoice_date");--> statement-breakpoint
CREATE INDEX "invoices_status_date_idx" ON "core"."invoices" USING btree ("status","invoice_date");--> statement-breakpoint
CREATE INDEX "invoices_service_category_date_idx" ON "core"."invoices" USING btree ("service_category_id","invoice_date");--> statement-breakpoint
CREATE INDEX "receipts_status_date_idx" ON "core"."receipts" USING btree ("status","received_date");--> statement-breakpoint
CREATE INDEX "receipts_method_date_idx" ON "core"."receipts" USING btree ("method","received_date");--> statement-breakpoint
CREATE INDEX "adjustments_date_idx" ON "core"."settlement_adjustments" USING btree ("date");--> statement-breakpoint
CREATE INDEX "adjustments_active_date_idx" ON "core"."settlement_adjustments" USING btree ("date") WHERE "core"."settlement_adjustments"."reversed_at" is null;