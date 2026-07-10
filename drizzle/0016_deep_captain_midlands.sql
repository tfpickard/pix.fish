CREATE TABLE "path_traffic" (
	"id" serial PRIMARY KEY NOT NULL,
	"src_id" integer NOT NULL,
	"dst_id" integer NOT NULL,
	"value" real DEFAULT 0 NOT NULL,
	"lifetime" real DEFAULT 0 NOT NULL,
	"last_updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "image_attention" ADD COLUMN "lifetime" real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "path_traffic" ADD CONSTRAINT "path_traffic_src_id_images_id_fk" FOREIGN KEY ("src_id") REFERENCES "public"."images"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "path_traffic" ADD CONSTRAINT "path_traffic_dst_id_images_id_fk" FOREIGN KEY ("dst_id") REFERENCES "public"."images"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "path_traffic_src_idx" ON "path_traffic" USING btree ("src_id");--> statement-breakpoint
CREATE UNIQUE INDEX "path_traffic_src_dst_uniq" ON "path_traffic" USING btree ("src_id","dst_id");