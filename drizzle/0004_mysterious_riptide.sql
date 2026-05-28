CREATE TABLE "constraint_cards" (
	"id" serial PRIMARY KEY NOT NULL,
	"category" text NOT NULL,
	"text" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grammar_fillers" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"slot_name" text NOT NULL,
	"filler" text NOT NULL,
	"weight" double precision DEFAULT 1 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grammar_slots" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"template" text NOT NULL,
	"frequency" integer DEFAULT 1 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "grammar_fillers" ADD CONSTRAINT "grammar_fillers_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grammar_slots" ADD CONSTRAINT "grammar_slots_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "constraint_cards_category_text_uniq" ON "constraint_cards" USING btree ("category","text");--> statement-breakpoint
CREATE INDEX "constraint_cards_category_idx" ON "constraint_cards" USING btree ("category");--> statement-breakpoint
CREATE UNIQUE INDEX "grammar_fillers_owner_slot_filler_uniq" ON "grammar_fillers" USING btree ("owner_id","slot_name","filler");--> statement-breakpoint
CREATE INDEX "grammar_fillers_owner_slot_idx" ON "grammar_fillers" USING btree ("owner_id","slot_name");--> statement-breakpoint
CREATE UNIQUE INDEX "grammar_slots_owner_template_uniq" ON "grammar_slots" USING btree ("owner_id","template");--> statement-breakpoint
CREATE INDEX "grammar_slots_owner_idx" ON "grammar_slots" USING btree ("owner_id");