ALTER TABLE "comments" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "geo_city" text;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "geo_region" text;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "geo_country" text;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comments_user_id_idx" ON "comments" USING btree ("user_id");