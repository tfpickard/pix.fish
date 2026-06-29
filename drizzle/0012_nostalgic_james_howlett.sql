CREATE TABLE "character_appearances" (
	"id" serial PRIMARY KEY NOT NULL,
	"character_key" text NOT NULL,
	"image_id" integer NOT NULL,
	"crop_url" text,
	"box" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "character_crops" (
	"id" serial PRIMARY KEY NOT NULL,
	"image_id" integer NOT NULL,
	"label" text NOT NULL,
	"description" text NOT NULL,
	"box" jsonb NOT NULL,
	"blob_url" text NOT NULL,
	"blob_key" text NOT NULL,
	"vec" vector(1536) NOT NULL,
	"provider" text,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "characters" (
	"key" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"dossier" text NOT NULL,
	"clerk_slug" text NOT NULL,
	"canonical_crop_url" text,
	"appearance_count" integer DEFAULT 0 NOT NULL,
	"census_event_id" bigint NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "character_appearances" ADD CONSTRAINT "character_appearances_image_id_images_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."images"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "character_crops" ADD CONSTRAINT "character_crops_image_id_images_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."images"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "character_appearances_character_idx" ON "character_appearances" USING btree ("character_key");--> statement-breakpoint
CREATE INDEX "character_appearances_image_idx" ON "character_appearances" USING btree ("image_id");--> statement-breakpoint
CREATE UNIQUE INDEX "character_appearances_char_image_uniq" ON "character_appearances" USING btree ("character_key","image_id");--> statement-breakpoint
CREATE INDEX "character_crops_image_idx" ON "character_crops" USING btree ("image_id");