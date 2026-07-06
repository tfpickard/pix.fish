CREATE TABLE "character_candidates" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_stamp" bigint NOT NULL,
	"candidate_index" integer NOT NULL,
	"crop_ids" integer[] NOT NULL,
	"verified_groups" jsonb,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "character_labels" (
	"id" serial PRIMARY KEY NOT NULL,
	"subject_label" text NOT NULL,
	"image_id" integer NOT NULL,
	"verdict" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "character_tuning" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"max_dist" real DEFAULT 0.45 NOT NULL,
	"k" integer DEFAULT 5 NOT NULL,
	"prune_k" integer DEFAULT 4 NOT NULL,
	"min_appearances" integer DEFAULT 2 NOT NULL,
	"verify_enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "character_labels" ADD CONSTRAINT "character_labels_image_id_images_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."images"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "character_candidates_run_idx" ON "character_candidates" USING btree ("run_stamp");--> statement-breakpoint
CREATE UNIQUE INDEX "character_candidates_run_cand_uniq" ON "character_candidates" USING btree ("run_stamp","candidate_index");--> statement-breakpoint
CREATE INDEX "character_labels_subject_idx" ON "character_labels" USING btree ("subject_label");--> statement-breakpoint
CREATE UNIQUE INDEX "character_labels_subject_image_uniq" ON "character_labels" USING btree ("subject_label","image_id");