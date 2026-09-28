ALTER TABLE "core"."invoices" DROP CONSTRAINT "invoice_number_state";--> statement-breakpoint
ALTER TABLE "core"."bank_accounts" ADD COLUMN "bank_name" text;--> statement-breakpoint
UPDATE "core"."invoices" AS "invoice"
SET "snapshot" = jsonb_set(
  "invoice"."snapshot",
  '{guest}',
  COALESCE((
    SELECT jsonb_build_object('id', "guest"."id", 'name', "guest"."name")
    FROM "core"."guests" AS "guest"
    WHERE "guest"."id" = "invoice"."guest_id"
  ), 'null'::jsonb),
  true
)
WHERE "invoice"."snapshot" IS NOT NULL
  AND NOT "invoice"."snapshot" ? 'guest';--> statement-breakpoint
UPDATE "core"."invoices" AS "invoice"
SET "snapshot" = jsonb_set(
  "invoice"."snapshot",
  '{bankAccounts}',
  COALESCE((
    SELECT jsonb_agg(
      "account" || jsonb_build_object(
        'bankName', COALESCE(
          "account"->'bankName',
          to_jsonb("bank"."bank_name"),
          'null'::jsonb
        )
      ) ORDER BY "selected"."ordinality"
    )
    FROM jsonb_array_elements(
      COALESCE("invoice"."snapshot"->'bankAccounts', '[]'::jsonb)
    ) WITH ORDINALITY AS "selected"("account", "ordinality")
    LEFT JOIN "core"."bank_accounts" AS "bank"
      ON "bank"."id"::text = "selected"."account"->>'id'
  ), '[]'::jsonb),
  true
)
WHERE "invoice"."snapshot" IS NOT NULL;--> statement-breakpoint
UPDATE "core"."invoices" AS "invoice"
SET "snapshot" = jsonb_build_object(
  'schemaVersion', 1,
  'company', jsonb_build_object(
    'id', "company"."id",
    'name', "company"."name",
    'address', "company"."address",
    'state', "company"."state",
    'country', "company"."country"
  ),
  'customer', jsonb_build_object(
    'id', "customer"."id",
    'name', "customer"."name"
  ),
  'guest', (
    SELECT jsonb_build_object('id', "guest"."id", 'name', "guest"."name")
    FROM "core"."guests" AS "guest"
    WHERE "guest"."id" = "invoice"."guest_id"
  ),
  'serviceCategory', jsonb_build_object(
    'id', "category"."id",
    'name', "category"."name",
    'code', "category"."code"
  ),
  'bankAccounts', COALESCE((
    SELECT jsonb_agg(
      jsonb_build_object(
        'id', "bank"."id",
        'name', "bank"."name",
        'bankName', "bank"."bank_name",
        'accountNumber', "bank"."account_number",
        'branch', "bank"."branch",
        'ifscCode', "bank"."ifsc_code"
      ) ORDER BY "selected"."ordinality"
    )
    FROM jsonb_array_elements_text(
      COALESCE("invoice"."details"->'bankAccountIds', '[]'::jsonb)
    ) WITH ORDINALITY AS "selected"("id", "ordinality")
    JOIN "core"."bank_accounts" AS "bank" ON "bank"."id"::text = "selected"."id"
  ), '[]'::jsonb),
  'currency', 'INR',
  'rounding', 'HALF_UP_PER_LINE_COMPONENT',
  'taxEffectiveDate', "invoice"."invoice_date"
)
FROM "core"."companies" AS "company",
  "core"."customers" AS "customer",
  "core"."service_categories" AS "category"
WHERE "invoice"."status" = 'DRAFT'
  AND "invoice"."snapshot" IS NULL
  AND "company"."id" = "invoice"."company_id"
  AND "customer"."id" = "invoice"."customer_id"
  AND "category"."id" = "invoice"."service_category_id";--> statement-breakpoint
ALTER TABLE "core"."invoices" ADD CONSTRAINT "invoice_number_state" CHECK (("core"."invoices"."status" = 'DRAFT' AND "core"."invoices"."invoice_number" IS NULL AND "core"."invoices"."snapshot" IS NOT NULL AND "core"."invoices"."issued_at" IS NULL) OR ("core"."invoices"."status" <> 'DRAFT' AND "core"."invoices"."invoice_number" IS NOT NULL AND "core"."invoices"."snapshot" IS NOT NULL AND "core"."invoices"."issued_at" IS NOT NULL));
