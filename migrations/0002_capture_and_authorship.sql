CREATE TABLE "known_other_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"email" "citext" NOT NULL,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "known_other_identities_unq" UNIQUE("user_id","email")
);
--> statement-breakpoint
ALTER TABLE "repos" ALTER COLUMN "installation_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "repos" ALTER COLUMN "github_repo_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "repos" ALTER COLUMN "owner" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "repos" ALTER COLUMN "is_private" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "candidates" ADD COLUMN "commit_index_at_introduction" integer;--> statement-breakpoint
ALTER TABLE "candidates" ADD COLUMN "commit_count_at_detection" integer;--> statement-breakpoint
ALTER TABLE "candidates" ADD COLUMN "introduced_by" text NOT NULL;--> statement-breakpoint
ALTER TABLE "candidates" ADD COLUMN "introducing_author_email" "citext";--> statement-breakpoint
ALTER TABLE "candidates" ADD COLUMN "authorship_version" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "candidates" ADD COLUMN "authorship_disputed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "candidates" ADD COLUMN "skip_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "role" text NOT NULL;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "source" text DEFAULT 'github' NOT NULL;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "local_path" text;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "root_sha" char(40);--> statement-breakpoint
ALTER TABLE "known_other_identities" ADD CONSTRAINT "known_other_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "repos_local_clone_unq" ON "repos" USING btree ("local_path","root_sha") WHERE source = 'local_clone';--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_introduced_by" CHECK ("candidates"."introduced_by" IN ('builder', 'builder_with_agent', 'agent', 'template', 'automation', 'other_human', 'unknown'));--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_role" CHECK ("decisions"."role" IN ('made', 'directed', 'kept'));--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_source" CHECK ("repos"."source" IN ('github', 'local_clone'));--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_github_fields" CHECK ("repos"."source" <> 'github' OR (
        "repos"."installation_id" IS NOT NULL
        AND "repos"."github_repo_id" IS NOT NULL
        AND "repos"."owner" IS NOT NULL
        AND "repos"."is_private" IS NOT NULL
      ));--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_local_clone_fields" CHECK ("repos"."source" <> 'local_clone' OR (
        "repos"."local_path" IS NOT NULL AND "repos"."root_sha" IS NOT NULL
      ));