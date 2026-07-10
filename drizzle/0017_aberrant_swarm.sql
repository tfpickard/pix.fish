ALTER TABLE "character_crops" ADD COLUMN "vec_image" vector(1024);--> statement-breakpoint
ALTER TABLE "character_crops" ADD COLUMN "image_provider" text;--> statement-breakpoint
ALTER TABLE "character_crops" ADD COLUMN "image_model" text;--> statement-breakpoint
ALTER TABLE "character_tuning" ADD COLUMN "space" text DEFAULT 'text' NOT NULL;--> statement-breakpoint
ALTER TABLE "character_tuning" ADD COLUMN "blend_weight" real DEFAULT 0.5 NOT NULL;