CREATE TABLE "clerks" (
	"slug" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"department" text NOT NULL,
	"voice" text NOT NULL,
	"agenda" text NOT NULL,
	"commissioned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cross_references" (
	"id" serial PRIMARY KEY NOT NULL,
	"src_image_id" integer NOT NULL,
	"dst_image_id" integer NOT NULL,
	"dist" real,
	"kind" text DEFAULT 'knn' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "districts" (
	"key" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"character" text NOT NULL,
	"size" integer DEFAULT 0 NOT NULL,
	"member_image_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"author_clerk" text,
	"payload" jsonb NOT NULL,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lore_fragments" (
	"id" serial PRIMARY KEY NOT NULL,
	"specimen_image_id" integer NOT NULL,
	"event_id" bigint NOT NULL,
	"clerk_slug" text NOT NULL,
	"kind" text DEFAULT 'intake' NOT NULL,
	"body" text NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"x" real,
	"y" real,
	"z" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "specimens" (
	"image_id" integer PRIMARY KEY NOT NULL,
	"clerk_slug" text NOT NULL,
	"district_key" text NOT NULL,
	"current_dossier" text NOT NULL,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"intake_event_id" bigint NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "embeddings" ALTER COLUMN "image_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "embeddings" ADD COLUMN "lore_fragment_id" integer;--> statement-breakpoint
ALTER TABLE "embeddings" ADD COLUMN "subject_type" text DEFAULT 'image' NOT NULL;--> statement-breakpoint
ALTER TABLE "knn_edges" ADD COLUMN "src_type" text DEFAULT 'image' NOT NULL;--> statement-breakpoint
ALTER TABLE "knn_edges" ADD COLUMN "dst_type" text DEFAULT 'image' NOT NULL;--> statement-breakpoint
ALTER TABLE "cross_references" ADD CONSTRAINT "cross_references_src_image_id_images_id_fk" FOREIGN KEY ("src_image_id") REFERENCES "public"."images"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_references" ADD CONSTRAINT "cross_references_dst_image_id_images_id_fk" FOREIGN KEY ("dst_image_id") REFERENCES "public"."images"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lore_fragments" ADD CONSTRAINT "lore_fragments_specimen_image_id_images_id_fk" FOREIGN KEY ("specimen_image_id") REFERENCES "public"."images"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specimens" ADD CONSTRAINT "specimens_image_id_images_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."images"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cross_references_src_idx" ON "cross_references" USING btree ("src_image_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cross_references_src_dst_kind_uniq" ON "cross_references" USING btree ("src_image_id","dst_image_id","kind");--> statement-breakpoint
CREATE INDEX "events_subject_idx" ON "events" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "events_type_idx" ON "events" USING btree ("type");--> statement-breakpoint
CREATE UNIQUE INDEX "events_dedupe_key_uniq" ON "events" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "lore_fragments_specimen_idx" ON "lore_fragments" USING btree ("specimen_image_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "lore_fragments_event_uniq" ON "lore_fragments" USING btree ("event_id");--> statement-breakpoint
ALTER TABLE "embeddings" ADD CONSTRAINT "embeddings_lore_fragment_id_lore_fragments_id_fk" FOREIGN KEY ("lore_fragment_id") REFERENCES "public"."lore_fragments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "embeddings_lore_kind_uniq" ON "embeddings" USING btree ("lore_fragment_id","kind");--> statement-breakpoint
CREATE INDEX "embeddings_lore_fragment_id_idx" ON "embeddings" USING btree ("lore_fragment_id");--> statement-breakpoint
ALTER TABLE "embeddings" ADD CONSTRAINT "embeddings_subject_one_of" CHECK ((image_id IS NOT NULL)::int + (lore_fragment_id IS NOT NULL)::int = 1);