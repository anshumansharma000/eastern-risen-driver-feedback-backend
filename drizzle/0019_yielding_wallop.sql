ALTER TABLE "core"."service_categories" ADD COLUMN "requires_vehicle" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "core"."service_categories"
SET "requires_vehicle" = true
WHERE lower(btrim("name")) = 'car service';--> statement-breakpoint
ALTER TABLE "core"."invoices" ADD COLUMN "vehicle_id" uuid;--> statement-breakpoint
CREATE INDEX "invoices_vehicle_date_idx" ON "core"."invoices" USING btree ("vehicle_id","invoice_date");
