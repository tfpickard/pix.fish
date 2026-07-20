CREATE TABLE "desire_paths" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"edge_sig" text NOT NULL,
	"node_ids" jsonb NOT NULL,
	"caption" text,
	"provider" text,
	"model" text,
	"strength" real DEFAULT 0 NOT NULL,
	"lifetime" real DEFAULT 0 NOT NULL,
	"last_walked_at" timestamp with time zone,
	"promoted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "desire_paths_slug_unique" UNIQUE("slug"),
	CONSTRAINT "desire_paths_edge_sig_unique" UNIQUE("edge_sig")
);
--> statement-breakpoint
CREATE INDEX "desire_paths_strength_idx" ON "desire_paths" USING btree ("strength");--> statement-breakpoint
CREATE INDEX "desire_paths_retired_idx" ON "desire_paths" USING btree ("retired_at");