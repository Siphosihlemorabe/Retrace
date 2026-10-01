CREATE TABLE "learning_goal_outcome_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"goal_id" uuid NOT NULL,
	"outcome_id" uuid NOT NULL,
	"in_objective" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "learning_goal_outcomes" (
	"goal_id" uuid NOT NULL,
	"outcome_id" uuid NOT NULL,
	"in_objective" boolean NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "learning_goal_outcomes_goal_id_outcome_id_pk" PRIMARY KEY("goal_id","outcome_id")
);
--> statement-breakpoint
CREATE TABLE "line_labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"sha" char(40) NOT NULL,
	"path" text NOT NULL,
	"line_start" integer NOT NULL,
	"line_end" integer NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "line_labels_label" CHECK ("line_labels"."label" IN ('agent', 'me')),
	CONSTRAINT "line_labels_lines" CHECK ("line_labels"."line_start" >= 1 AND "line_labels"."line_end" >= "line_labels"."line_start")
);
--> statement-breakpoint
CREATE TABLE "outcome_sightings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"outcome_id" uuid NOT NULL,
	"sha" char(40) NOT NULL,
	"path" text NOT NULL,
	"line_start" integer NOT NULL,
	"line_end" integer NOT NULL,
	"via" text NOT NULL,
	"found_by" text DEFAULT 'rule' NOT NULL,
	"scan_kind" text NOT NULL,
	"authorship" text NOT NULL,
	"authorship_version" integer NOT NULL,
	"detector_version" integer NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outcome_sightings_unq" UNIQUE("repo_id","outcome_id","sha","path","line_start","line_end"),
	CONSTRAINT "outcome_sightings_via" CHECK ("outcome_sightings"."via" IN ('sql', 'orm', 'config', 'code')),
	CONSTRAINT "outcome_sightings_found_by" CHECK ("outcome_sightings"."found_by" IN ('rule', 'model')),
	CONSTRAINT "outcome_sightings_scan_kind" CHECK ("outcome_sightings"."scan_kind" IN ('commit', 'snapshot')),
	CONSTRAINT "outcome_sightings_authorship" CHECK ("outcome_sightings"."authorship" IN ('builder', 'builder_with_agent', 'agent', 'template', 'automation', 'other_human', 'unknown')),
	CONSTRAINT "outcome_sightings_lines" CHECK ("outcome_sightings"."line_start" >= 1 AND "outcome_sightings"."line_end" >= "outcome_sightings"."line_start")
);
--> statement-breakpoint
CREATE TABLE "skill_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"skill_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"ordinal" smallint NOT NULL,
	"source" text DEFAULT 'builtin' NOT NULL,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_outcomes_slug_unique" UNIQUE("slug"),
	CONSTRAINT "skill_outcomes_source" CHECK ("skill_outcomes"."source" IN ('builtin', 'model_reviewed', 'builder'))
);
--> statement-breakpoint
ALTER TABLE "commit_sightings" DROP CONSTRAINT "commit_sightings_source";--> statement-breakpoint
ALTER TABLE "learning_goals" ADD COLUMN "kind" text DEFAULT 'gap' NOT NULL;--> statement-breakpoint
ALTER TABLE "learning_goals" ADD COLUMN "repo_id" uuid;--> statement-breakpoint
ALTER TABLE "learning_goals" ADD COLUMN "declared_at_sha" char(40);--> statement-breakpoint
ALTER TABLE "learning_goal_outcome_changes" ADD CONSTRAINT "learning_goal_outcome_changes_goal_id_learning_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."learning_goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_goal_outcome_changes" ADD CONSTRAINT "learning_goal_outcome_changes_outcome_id_skill_outcomes_id_fk" FOREIGN KEY ("outcome_id") REFERENCES "public"."skill_outcomes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_goal_outcomes" ADD CONSTRAINT "learning_goal_outcomes_goal_id_learning_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."learning_goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_goal_outcomes" ADD CONSTRAINT "learning_goal_outcomes_outcome_id_skill_outcomes_id_fk" FOREIGN KEY ("outcome_id") REFERENCES "public"."skill_outcomes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "line_labels" ADD CONSTRAINT "line_labels_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "line_labels" ADD CONSTRAINT "line_labels_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcome_sightings" ADD CONSTRAINT "outcome_sightings_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcome_sightings" ADD CONSTRAINT "outcome_sightings_outcome_id_skill_outcomes_id_fk" FOREIGN KEY ("outcome_id") REFERENCES "public"."skill_outcomes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_outcomes" ADD CONSTRAINT "skill_outcomes_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "line_labels_file_idx" ON "line_labels" USING btree ("repo_id","path");--> statement-breakpoint
CREATE INDEX "outcome_sightings_repo_outcome_idx" ON "outcome_sightings" USING btree ("repo_id","outcome_id");--> statement-breakpoint
ALTER TABLE "learning_goals" ADD CONSTRAINT "learning_goals_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "learning_goals_intent_unq" ON "learning_goals" USING btree ("user_id","repo_id","skill_id") WHERE kind = 'intent';--> statement-breakpoint
ALTER TABLE "commit_sightings" ADD CONSTRAINT "commit_sightings_source" CHECK ("commit_sightings"."source" IN ('webhook', 'backfill', 'manual_import', 'local_scan'));--> statement-breakpoint
ALTER TABLE "learning_goals" ADD CONSTRAINT "learning_goals_kind" CHECK ("learning_goals"."kind" IN ('gap', 'intent'));--> statement-breakpoint
ALTER TABLE "learning_goals" ADD CONSTRAINT "learning_goals_intent_fields" CHECK ("learning_goals"."kind" <> 'intent' OR (
        "learning_goals"."repo_id" IS NOT NULL AND "learning_goals"."skill_id" IS NOT NULL AND "learning_goals"."declared_at_sha" IS NOT NULL
      ));