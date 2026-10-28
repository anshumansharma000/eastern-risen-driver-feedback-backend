CREATE TABLE "core"."inquiries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"full_name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text NOT NULL,
	"details" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "inquiries_created_at_idx" ON "core"."inquiries" USING btree ("created_at","id");