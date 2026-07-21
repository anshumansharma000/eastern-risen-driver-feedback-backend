CREATE TYPE "public"."account_role" AS ENUM('ADMIN', 'DRIVER');--> statement-breakpoint
CREATE TYPE "public"."driver_source_type" AS ENUM('AGENCY', 'OUTSOURCED');--> statement-breakpoint
CREATE TYPE "public"."lifecycle_status" AS ENUM('ACTIVE', 'DEACTIVATED', 'ARCHIVED');--> statement-breakpoint
CREATE TABLE "auth_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"role" "account_role" NOT NULL,
	"display_name" text NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"status" "lifecycle_status" DEFAULT 'ACTIVE' NOT NULL,
	"password_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "auth_accounts_archived_at_check" CHECK (("auth_accounts"."status" = 'ARCHIVED' AND "auth_accounts"."archived_at" IS NOT NULL)
          OR ("auth_accounts"."status" <> 'ARCHIVED' AND "auth_accounts"."archived_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "drivers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"driver_code" text NOT NULL,
	"phone" text,
	"source_type" "driver_source_type" NOT NULL,
	"vendor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drivers_account_id_unique" UNIQUE("account_id"),
	CONSTRAINT "drivers_source_vendor_check" CHECK (("drivers"."source_type" = 'OUTSOURCED' AND "drivers"."vendor_id" IS NOT NULL)
          OR ("drivers"."source_type" = 'AGENCY' AND "drivers"."vendor_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "agency_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"singleton_key" boolean DEFAULT true NOT NULL,
	"agency_name" text NOT NULL,
	"timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"default_thank_you_message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agency_settings_singleton_unique" UNIQUE("singleton_key"),
	CONSTRAINT "agency_settings_singleton_check" CHECK ("agency_settings"."singleton_key" = true)
);
--> statement-breakpoint
CREATE TABLE "vehicles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"registration_number" text NOT NULL,
	"display_name" text NOT NULL,
	"status" "lifecycle_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "vehicles_archived_at_check" CHECK (("vehicles"."status" = 'ARCHIVED' AND "vehicles"."archived_at" IS NOT NULL)
          OR ("vehicles"."status" <> 'ARCHIVED' AND "vehicles"."archived_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "vendors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"contact_name" text,
	"contact_email" text,
	"contact_phone" text,
	"status" "lifecycle_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "vendors_archived_at_check" CHECK (("vendors"."status" = 'ARCHIVED' AND "vendors"."archived_at" IS NOT NULL)
          OR ("vendors"."status" <> 'ARCHIVED' AND "vendors"."archived_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_account_id_auth_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."auth_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_accounts_email_unique" ON "auth_accounts" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "auth_accounts_status_idx" ON "auth_accounts" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "drivers_code_unique" ON "drivers" USING btree (lower("driver_code"));--> statement-breakpoint
CREATE INDEX "drivers_source_vendor_idx" ON "drivers" USING btree ("source_type","vendor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vehicles_registration_unique" ON "vehicles" USING btree (upper("registration_number"));--> statement-breakpoint
CREATE INDEX "vehicles_status_idx" ON "vehicles" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "vendors_active_name_unique" ON "vendors" USING btree (lower("name")) WHERE "vendors"."status" <> 'ARCHIVED';--> statement-breakpoint
CREATE INDEX "vendors_status_idx" ON "vendors" USING btree ("status");