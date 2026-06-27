CREATE TABLE "fish_config" (
	"id" serial PRIMARY KEY NOT NULL,
	"field" text NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fish_config_field_unique" UNIQUE("field")
);
