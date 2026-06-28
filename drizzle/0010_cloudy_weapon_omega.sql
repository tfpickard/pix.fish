CREATE TABLE "taste_votes" (
	"id" serial PRIMARY KEY NOT NULL,
	"winner_id" integer NOT NULL,
	"loser_id" integer NOT NULL,
	"ip_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "taste_votes" ADD CONSTRAINT "taste_votes_winner_id_images_id_fk" FOREIGN KEY ("winner_id") REFERENCES "public"."images"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "taste_votes" ADD CONSTRAINT "taste_votes_loser_id_images_id_fk" FOREIGN KEY ("loser_id") REFERENCES "public"."images"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "taste_votes_winner_idx" ON "taste_votes" USING btree ("winner_id");--> statement-breakpoint
CREATE INDEX "taste_votes_loser_idx" ON "taste_votes" USING btree ("loser_id");