ALTER TABLE "vehicles" ADD COLUMN "vehicle_type" text;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "registered_owner" text;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "address" text;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "contact_number" text;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "account_number" text;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "ifsc_code" text;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "bank_name" text;--> statement-breakpoint
UPDATE "vehicles" AS "vehicle"
SET
  "vehicle_type" = COALESCE(NULLIF(BTRIM("profile"."vehicle_type"), ''), 'UNSPECIFIED'),
  "registered_owner" = NULLIF(BTRIM("profile"."registered_owner"), ''),
  "address" = NULLIF(BTRIM("profile"."address"), ''),
  "contact_number" = NULLIF(BTRIM("profile"."contact_number"), ''),
  "account_number" = NULLIF(BTRIM("profile"."account_number"), ''),
  "ifsc_code" = NULLIF(UPPER(BTRIM("profile"."ifsc_code")), ''),
  "bank_name" = NULLIF(BTRIM("profile"."bank_name"), '')
FROM "core"."vehicle_profiles" AS "profile"
WHERE "profile"."vehicle_id" = "vehicle"."id";--> statement-breakpoint
UPDATE "vehicles" SET "vehicle_type" = 'UNSPECIFIED' WHERE "vehicle_type" IS NULL;--> statement-breakpoint
ALTER TABLE "vehicles" ALTER COLUMN "vehicle_type" SET NOT NULL;--> statement-breakpoint
DROP TABLE "core"."vehicle_profiles";
