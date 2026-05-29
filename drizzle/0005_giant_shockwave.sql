CREATE TABLE "image_lineage" (
	"id" serial PRIMARY KEY NOT NULL,
	"child_image_id" integer NOT NULL,
	"parent_image_id" integer NOT NULL,
	"prompt_used" text,
	"dialect_used" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "remix_idioms" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"description" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vibe_axes" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"negative_pole" text NOT NULL,
	"positive_pole" text NOT NULL,
	"ordering" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "image_lineage" ADD CONSTRAINT "image_lineage_child_image_id_images_id_fk" FOREIGN KEY ("child_image_id") REFERENCES "public"."images"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_lineage" ADD CONSTRAINT "image_lineage_parent_image_id_images_id_fk" FOREIGN KEY ("parent_image_id") REFERENCES "public"."images"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "image_lineage_child_parent_uniq" ON "image_lineage" USING btree ("child_image_id","parent_image_id");--> statement-breakpoint
CREATE INDEX "image_lineage_child_idx" ON "image_lineage" USING btree ("child_image_id");--> statement-breakpoint
CREATE INDEX "image_lineage_parent_idx" ON "image_lineage" USING btree ("parent_image_id");--> statement-breakpoint
CREATE UNIQUE INDEX "remix_idioms_key_uniq" ON "remix_idioms" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "vibe_axes_key_uniq" ON "vibe_axes" USING btree ("key");