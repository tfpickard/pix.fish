CREATE TABLE "collection_temperature" (
	"id" serial PRIMARY KEY NOT NULL,
	"value" real NOT NULL,
	"point_count" integer DEFAULT 0 NOT NULL,
	"meta" jsonb,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "image_attention" (
	"image_id" integer PRIMARY KEY NOT NULL,
	"value" real DEFAULT 0 NOT NULL,
	"last_updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knn_edges" (
	"id" serial PRIMARY KEY NOT NULL,
	"src_id" integer NOT NULL,
	"dst_id" integer NOT NULL,
	"dist" real NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "manifold_projections" (
	"id" serial PRIMARY KEY NOT NULL,
	"seed" integer NOT NULL,
	"points" jsonb NOT NULL,
	"point_count" integer NOT NULL,
	"params" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "images" ADD COLUMN "surprisal" real;--> statement-breakpoint
ALTER TABLE "images" ADD COLUMN "generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "images" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "images" ADD COLUMN "basement" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "image_attention" ADD CONSTRAINT "image_attention_image_id_images_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."images"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knn_edges" ADD CONSTRAINT "knn_edges_src_id_images_id_fk" FOREIGN KEY ("src_id") REFERENCES "public"."images"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knn_edges" ADD CONSTRAINT "knn_edges_dst_id_images_id_fk" FOREIGN KEY ("dst_id") REFERENCES "public"."images"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "collection_temperature_computed_idx" ON "collection_temperature" USING btree ("computed_at");--> statement-breakpoint
CREATE INDEX "knn_edges_src_idx" ON "knn_edges" USING btree ("src_id");--> statement-breakpoint
CREATE UNIQUE INDEX "knn_edges_src_dst_uniq" ON "knn_edges" USING btree ("src_id","dst_id");--> statement-breakpoint
CREATE INDEX "manifold_projections_created_idx" ON "manifold_projections" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "images_surprisal_idx" ON "images" USING btree ("surprisal");--> statement-breakpoint
CREATE INDEX "images_archived_idx" ON "images" USING btree ("archived_at");--> statement-breakpoint
CREATE INDEX "images_basement_idx" ON "images" USING btree ("basement");