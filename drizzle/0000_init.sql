-- Enable pgvector now so Phase 2 embeddings migration has zero friction.
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"label" text,
	"key_hash" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "captions" (
	"id" serial PRIMARY KEY NOT NULL,
	"image_id" integer NOT NULL,
	"variant" integer NOT NULL,
	"text" text NOT NULL,
	"provider" text,
	"model" text,
	"is_slug_source" boolean DEFAULT false NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "descriptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"image_id" integer NOT NULL,
	"variant" integer NOT NULL,
	"text" text NOT NULL,
	"provider" text,
	"model" text,
	"locked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "images" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"slug_history" text[] DEFAULT '{}' NOT NULL,
	"blob_url" text NOT NULL,
	"blob_key" text NOT NULL,
	"mime" text,
	"width" integer,
	"height" integer,
	"taken_at" timestamp with time zone,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"owner_id" text NOT NULL,
	"exif" jsonb,
	"palette" text[],
	"manual_caption" text,
	CONSTRAINT "images_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "prompts" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"template" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prompts_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "tag_taxonomy" (
	"id" serial PRIMARY KEY NOT NULL,
	"tag" text NOT NULL,
	"category" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "tag_taxonomy_tag_unique" UNIQUE("tag")
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" serial PRIMARY KEY NOT NULL,
	"image_id" integer NOT NULL,
	"tag" text NOT NULL,
	"confidence" double precision,
	"source" text NOT NULL,
	"provider" text,
	"model" text
);
--> statement-breakpoint
ALTER TABLE "captions" ADD CONSTRAINT "captions_image_id_images_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."images"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "descriptions" ADD CONSTRAINT "descriptions_image_id_images_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."images"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_image_id_images_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."images"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "captions_image_id_idx" ON "captions" USING btree ("image_id");--> statement-breakpoint
CREATE INDEX "descriptions_image_id_idx" ON "descriptions" USING btree ("image_id");--> statement-breakpoint
CREATE INDEX "images_uploaded_at_idx" ON "images" USING btree ("uploaded_at");--> statement-breakpoint
CREATE INDEX "images_slug_history_idx" ON "images" USING gin ("slug_history");--> statement-breakpoint
CREATE UNIQUE INDEX "tags_image_tag_uniq" ON "tags" USING btree ("image_id","tag");--> statement-breakpoint
CREATE INDEX "tags_tag_idx" ON "tags" USING btree ("tag");