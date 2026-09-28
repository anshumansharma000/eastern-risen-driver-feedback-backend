CREATE SCHEMA "core";
--> statement-breakpoint
CREATE TYPE "core"."customer_category" AS ENUM('AGENT', 'LEISURE', 'CORPORATE');--> statement-breakpoint
CREATE TYPE "core"."hotel_plan" AS ENUM('APAI', 'MAPAI', 'CPAI');--> statement-breakpoint
CREATE TYPE "core"."market_type" AS ENUM('DOMESTIC', 'INTERNATIONAL');--> statement-breakpoint
CREATE TYPE "core"."master_status" AS ENUM('ACTIVE', 'INACTIVE', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "core"."tax_component" AS ENUM('IGST', 'CGST', 'SGST', 'SERVICE_TAX');--> statement-breakpoint
CREATE TYPE "core"."invoice_status" AS ENUM('DRAFT', 'ISSUED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "core"."payment_method" AS ENUM('CASH', 'CHEQUE', 'DD', 'CARD', 'UPI');--> statement-breakpoint
CREATE TYPE "core"."receipt_status" AS ENUM('PENDING', 'CONFIRMED', 'REVERSED');--> statement-breakpoint
ALTER TYPE "public"."account_role" ADD VALUE 'CORE_ADMIN';--> statement-breakpoint
ALTER TYPE "public"."account_role" ADD VALUE 'CORE_REPORT_VIEWER';--> statement-breakpoint
ALTER TYPE "public"."account_role" ADD VALUE 'CORE_DATA_ENTRY';--> statement-breakpoint
CREATE TABLE "core"."bank_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "core"."master_status" DEFAULT 'ACTIVE' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"account_number" text NOT NULL,
	"branch" text,
	"ifsc_code" text,
	"swift_code" text
);
--> statement-breakpoint
CREATE TABLE "core"."companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "core"."master_status" DEFAULT 'ACTIVE' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"phone" text,
	"mobile_number" text,
	"email" text,
	"pan" text,
	"service_tax_number" text,
	"cin" text,
	"gst_number" text,
	"website" text,
	"state" text,
	"country" text,
	"postal_code" text,
	"branch_office" text,
	"payment_instructions" text,
	"footer_notes" text
);
--> statement-breakpoint
CREATE TABLE "core"."audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "core"."customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "core"."master_status" DEFAULT 'ACTIVE' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"category" "core"."customer_category" NOT NULL,
	"address" text,
	"city" text,
	"state" text,
	"country" text,
	"postal_code" text,
	"phone" text,
	"mobile_number" text,
	"email" text,
	"contact_person" text,
	"pan" text,
	"service_tax_number" text,
	"gst_number" text,
	"market" "core"."market_type"
);
--> statement-breakpoint
CREATE TABLE "core"."guests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "core"."master_status" DEFAULT 'ACTIVE' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"city" text,
	"state" text,
	"country" text,
	"postal_code" text,
	"phone" text,
	"mobile_number" text,
	"email" text,
	"contact_person" text,
	"market" "core"."market_type",
	"legacy_last_service_availed" text,
	"legacy_last_amount_paid" numeric(18, 2)
);
--> statement-breakpoint
CREATE TABLE "core"."hotel_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "core"."master_status" DEFAULT 'ACTIVE' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"hotel_id" uuid NOT NULL,
	"plan" "core"."hotel_plan" NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"effective_from" date,
	"effective_to" date,
	"name" text NOT NULL,
	CONSTRAINT "hotel_rates_period" CHECK ("core"."hotel_rates"."effective_to" IS NULL OR "core"."hotel_rates"."effective_to" >= "core"."hotel_rates"."effective_from"),
	CONSTRAINT "hotel_rate_nonnegative" CHECK ("core"."hotel_rates"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "core"."hotels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "core"."master_status" DEFAULT 'ACTIVE' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"city" text,
	"state" text,
	"country" text,
	"postal_code" text,
	"phone" text,
	"mobile_number" text,
	"email" text,
	"contact_person" text,
	"market" "core"."market_type"
);
--> statement-breakpoint
CREATE TABLE "core"."legacy_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"source_table" text NOT NULL,
	"source_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"raw_record" jsonb NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."service_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "core"."master_status" DEFAULT 'ACTIVE' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."tax_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "core"."master_status" DEFAULT 'ACTIVE' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"component" "core"."tax_component" NOT NULL,
	"service_category_id" uuid,
	"rate" numeric(7, 4) NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	CONSTRAINT "tax_rate_range" CHECK ("core"."tax_rules"."rate" >= 0 AND "core"."tax_rules"."rate" <= 100),
	CONSTRAINT "tax_rules_period" CHECK ("core"."tax_rules"."effective_to" IS NULL OR "core"."tax_rules"."effective_to" >= "core"."tax_rules"."effective_from")
);
--> statement-breakpoint
CREATE TABLE "core"."vehicle_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "core"."master_status" DEFAULT 'ACTIVE' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"vehicle_type" text,
	"registered_owner" text,
	"address" text,
	"contact_number" text,
	"account_number" text,
	"ifsc_code" text,
	"bank_name" text
);
--> statement-breakpoint
CREATE TABLE "core"."vendor_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "core"."master_status" DEFAULT 'ACTIVE' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"address" text,
	"city" text,
	"state" text,
	"country" text,
	"postal_code" text,
	"mobile_number" text,
	"market" "core"."market_type"
);
--> statement-breakpoint
CREATE TABLE "core"."document_counters" (
	"company_id" uuid NOT NULL,
	"financial_year" text NOT NULL,
	"kind" text NOT NULL,
	"value" integer NOT NULL,
	CONSTRAINT "document_counters_company_id_financial_year_kind_pk" PRIMARY KEY("company_id","financial_year","kind"),
	CONSTRAINT "counter_range" CHECK ("core"."document_counters"."value" BETWEEN 1 AND 999999)
);
--> statement-breakpoint
CREATE TABLE "core"."invoice_line_taxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"line_id" uuid NOT NULL,
	"rule_id" uuid,
	"component" text NOT NULL,
	"rate" numeric(7, 4) NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	CONSTRAINT "line_tax_nonnegative" CHECK ("core"."invoice_line_taxes"."rate" >= 0 AND "core"."invoice_line_taxes"."rate" <= 100 AND "core"."invoice_line_taxes"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "core"."invoice_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"description" text NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"tax_treatment" text NOT NULL,
	"tax_amount" numeric(18, 2) NOT NULL,
	"total" numeric(18, 2) NOT NULL,
	CONSTRAINT "line_amount_check" CHECK ("core"."invoice_lines"."position" > 0 AND "core"."invoice_lines"."amount" >= 0 AND "core"."invoice_lines"."tax_amount" >= 0 AND "core"."invoice_lines"."total" = "core"."invoice_lines"."amount" + "core"."invoice_lines"."tax_amount")
);
--> statement-breakpoint
CREATE TABLE "core"."invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"guest_id" uuid,
	"service_category_id" uuid NOT NULL,
	"invoice_date" date NOT NULL,
	"financial_year" text,
	"invoice_number" text,
	"status" "core"."invoice_status" DEFAULT 'DRAFT' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"details" jsonb NOT NULL,
	"snapshot" jsonb,
	"subtotal" numeric(18, 2) NOT NULL,
	"tax_total" numeric(18, 2) NOT NULL,
	"grand_total" numeric(18, 2) NOT NULL,
	"created_by" uuid NOT NULL,
	"issued_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancellation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_number_state" CHECK (("core"."invoices"."status" = 'DRAFT' AND "core"."invoices"."invoice_number" IS NULL AND "core"."invoices"."snapshot" IS NULL AND "core"."invoices"."issued_at" IS NULL) OR ("core"."invoices"."status" <> 'DRAFT' AND "core"."invoices"."invoice_number" IS NOT NULL AND "core"."invoices"."snapshot" IS NOT NULL AND "core"."invoices"."issued_at" IS NOT NULL)),
	CONSTRAINT "invoice_totals_check" CHECK ("core"."invoices"."subtotal" >= 0 AND "core"."invoices"."tax_total" >= 0 AND "core"."invoices"."grand_total" = "core"."invoices"."subtotal" + "core"."invoices"."tax_total")
);
--> statement-breakpoint
CREATE TABLE "core"."receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"receipt_number" text NOT NULL,
	"financial_year" text NOT NULL,
	"received_date" date NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"method" "core"."payment_method" NOT NULL,
	"details" jsonb NOT NULL,
	"status" "core"."receipt_status" NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reversal_reason" text,
	CONSTRAINT "receipt_positive" CHECK ("core"."receipts"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "core"."settlement_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"reason" text NOT NULL,
	"date" date NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"created_by" uuid NOT NULL,
	"reversed_at" timestamp with time zone,
	"reversal_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "adjustment_positive" CHECK ("core"."settlement_adjustments"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "auth_accounts" ADD COLUMN "username" text;--> statement-breakpoint
ALTER TABLE "core"."bank_accounts" ADD CONSTRAINT "bank_accounts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "core"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."hotel_rates" ADD CONSTRAINT "hotel_rates_hotel_id_hotels_id_fk" FOREIGN KEY ("hotel_id") REFERENCES "core"."hotels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."tax_rules" ADD CONSTRAINT "tax_rules_service_category_id_service_categories_id_fk" FOREIGN KEY ("service_category_id") REFERENCES "core"."service_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."document_counters" ADD CONSTRAINT "document_counters_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "core"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."invoice_line_taxes" ADD CONSTRAINT "invoice_line_taxes_line_id_invoice_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "core"."invoice_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "core"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."invoices" ADD CONSTRAINT "invoices_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "core"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."invoices" ADD CONSTRAINT "invoices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "core"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."invoices" ADD CONSTRAINT "invoices_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "core"."guests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."invoices" ADD CONSTRAINT "invoices_service_category_id_service_categories_id_fk" FOREIGN KEY ("service_category_id") REFERENCES "core"."service_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."receipts" ADD CONSTRAINT "receipts_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "core"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."receipts" ADD CONSTRAINT "receipts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "core"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."settlement_adjustments" ADD CONSTRAINT "settlement_adjustments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "core"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bank_accounts_name_idx" ON "core"."bank_accounts" USING btree ("name","id");--> statement-breakpoint
CREATE INDEX "companies_name_idx" ON "core"."companies" USING btree ("name","id");--> statement-breakpoint
CREATE INDEX "core_audit_entity_idx" ON "core"."audit_events" USING btree ("entity_id","created_at");--> statement-breakpoint
CREATE INDEX "core_outbox_pending_idx" ON "core"."outbox" USING btree ("created_at") WHERE "core"."outbox"."published_at" IS NULL;--> statement-breakpoint
CREATE INDEX "customers_name_idx" ON "core"."customers" USING btree ("name","id");--> statement-breakpoint
CREATE INDEX "guests_name_idx" ON "core"."guests" USING btree ("name","id");--> statement-breakpoint
CREATE INDEX "hotel_rates_name_idx" ON "core"."hotel_rates" USING btree ("name","id");--> statement-breakpoint
CREATE INDEX "hotels_name_idx" ON "core"."hotels" USING btree ("name","id");--> statement-breakpoint
CREATE UNIQUE INDEX "legacy_source_unique" ON "core"."legacy_mappings" USING btree ("source","source_table","source_id");--> statement-breakpoint
CREATE INDEX "service_categories_name_idx" ON "core"."service_categories" USING btree ("name","id");--> statement-breakpoint
CREATE INDEX "tax_rules_name_idx" ON "core"."tax_rules" USING btree ("name","id");--> statement-breakpoint
CREATE UNIQUE INDEX "vehicle_profile_vehicle_unique" ON "core"."vehicle_profiles" USING btree ("vehicle_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_profile_vendor_unique" ON "core"."vendor_profiles" USING btree ("vendor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "line_component_unique" ON "core"."invoice_line_taxes" USING btree ("line_id","component");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_line_position_unique" ON "core"."invoice_lines" USING btree ("invoice_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_number_unique" ON "core"."invoices" USING btree ("company_id","financial_year","invoice_number");--> statement-breakpoint
CREATE INDEX "invoices_customer_date_idx" ON "core"."invoices" USING btree ("customer_id","invoice_date");--> statement-breakpoint
CREATE UNIQUE INDEX "receipt_idempotency_unique" ON "core"."receipts" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "receipt_number_unique" ON "core"."receipts" USING btree ("company_id","financial_year","receipt_number");--> statement-breakpoint
CREATE INDEX "receipts_invoice_idx" ON "core"."receipts" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "adjustment_idempotency_unique" ON "core"."settlement_adjustments" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "adjustments_invoice_idx" ON "core"."settlement_adjustments" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_accounts_username_unique" ON "auth_accounts" USING btree (lower("username"));