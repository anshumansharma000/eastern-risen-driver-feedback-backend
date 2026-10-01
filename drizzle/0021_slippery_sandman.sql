ALTER TYPE "core"."payment_method" ADD VALUE 'GATEWAY';--> statement-breakpoint
CREATE TABLE "core"."commercial_bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" text NOT NULL,
	"company_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"service_category_id" uuid NOT NULL,
	"title" text NOT NULL,
	"service_starts_on" date,
	"service_ends_on" date,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"invoice_id" uuid,
	"access_token_hash" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commercial_bookings_invoice_id_unique" UNIQUE("invoice_id"),
	CONSTRAINT "commercial_bookings_access_token_hash_unique" UNIQUE("access_token_hash"),
	CONSTRAINT "commercial_bookings_status_check" CHECK ("core"."commercial_bookings"."status" IN ('DRAFT','QUOTED','INVOICED','CONFIRMED','CANCELLED','COMPLETED')),
	CONSTRAINT "commercial_bookings_dates_check" CHECK ("core"."commercial_bookings"."service_ends_on" IS NULL OR "core"."commercial_bookings"."service_starts_on" IS NULL OR "core"."commercial_bookings"."service_ends_on" >= "core"."commercial_bookings"."service_starts_on")
);
--> statement-breakpoint
CREATE TABLE "core"."commercial_quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"description" text NOT NULL,
	"inclusions" text NOT NULL,
	"exclusions" text NOT NULL,
	"terms" text NOT NULL,
	"total" numeric(18, 2) NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"expires_on" date,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commercial_quotes_amount_check" CHECK ("core"."commercial_quotes"."total" > 0 AND "core"."commercial_quotes"."currency" = 'INR')
);
--> statement-breakpoint
CREATE TABLE "core"."payment_milestones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"label" text NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"due_on" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_milestones_amount_check" CHECK ("core"."payment_milestones"."amount" > 0 AND "core"."payment_milestones"."position" > 0)
);
--> statement-breakpoint
CREATE TABLE "core"."payment_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"milestone_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_order_id" text NOT NULL,
	"session_id" text,
	"amount" numeric(18, 2) NOT NULL,
	"status" text DEFAULT 'CREATING' NOT NULL,
	"provider_payment_id" text,
	"paid_at" timestamp with time zone,
	"receipt_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_orders_amount_check" CHECK ("core"."payment_orders"."amount" > 0),
	CONSTRAINT "payment_orders_status_check" CHECK ("core"."payment_orders"."status" IN ('CREATING','READY','PAID','EXPIRED','REVIEW_REQUIRED'))
);
--> statement-breakpoint
CREATE TABLE "core"."payment_policies" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"initial_percent" integer DEFAULT 30 NOT NULL,
	"balance_days_before" integer DEFAULT 30 NOT NULL,
	"full_payment_within_days" integer DEFAULT 30 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_policies_percent_check" CHECK ("core"."payment_policies"."initial_percent" BETWEEN 1 AND 99),
	CONSTRAINT "payment_policies_days_check" CHECK ("core"."payment_policies"."balance_days_before" BETWEEN 1 AND 365 AND "core"."payment_policies"."full_payment_within_days" BETWEEN 0 AND 365)
);
--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "commercial_booking_id" uuid;--> statement-breakpoint
ALTER TABLE "core"."commercial_bookings" ADD CONSTRAINT "commercial_bookings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "core"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."commercial_bookings" ADD CONSTRAINT "commercial_bookings_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "core"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."commercial_bookings" ADD CONSTRAINT "commercial_bookings_service_category_id_service_categories_id_fk" FOREIGN KEY ("service_category_id") REFERENCES "core"."service_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."commercial_bookings" ADD CONSTRAINT "commercial_bookings_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "core"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."commercial_quotes" ADD CONSTRAINT "commercial_quotes_booking_id_commercial_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "core"."commercial_bookings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."payment_milestones" ADD CONSTRAINT "payment_milestones_booking_id_commercial_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "core"."commercial_bookings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."payment_orders" ADD CONSTRAINT "payment_orders_milestone_id_payment_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "core"."payment_milestones"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."payment_orders" ADD CONSTRAINT "payment_orders_receipt_id_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "core"."receipts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."payment_policies" ADD CONSTRAINT "payment_policies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "core"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commercial_bookings_reference_unique" ON "core"."commercial_bookings" USING btree (lower("reference"));--> statement-breakpoint
CREATE INDEX "commercial_bookings_customer_idx" ON "core"."commercial_bookings" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "commercial_quotes_booking_version_unique" ON "core"."commercial_quotes" USING btree ("booking_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_milestones_booking_position_unique" ON "core"."payment_milestones" USING btree ("booking_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_orders_provider_order_unique" ON "core"."payment_orders" USING btree ("provider","provider_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_orders_provider_payment_unique" ON "core"."payment_orders" USING btree ("provider","provider_payment_id");--> statement-breakpoint
CREATE INDEX "payment_orders_milestone_idx" ON "core"."payment_orders" USING btree ("milestone_id","created_at");--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_commercial_booking_id_commercial_bookings_id_fk" FOREIGN KEY ("commercial_booking_id") REFERENCES "core"."commercial_bookings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bookings_commercial_booking_unique" ON "bookings" USING btree ("commercial_booking_id");