-- Hand-added: citext columns below need the extension to already exist.
-- Drizzle cannot emit this, and regenerating 0000 would drop it — but 0000 is
-- never regenerated once applied.
CREATE EXTENSION IF NOT EXISTS citext;
--> statement-breakpoint
CREATE TABLE "analysis_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cache_key" text NOT NULL,
	"kind" text NOT NULL,
	"repo_id" uuid,
	"sha" char(40),
	"prompt_version" integer NOT NULL,
	"analysis_version" integer NOT NULL,
	"model" text NOT NULL,
	"result" jsonb NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"cache_read_tokens" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analysis_cache_cache_key_unique" UNIQUE("cache_key")
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_key" text NOT NULL,
	"displaced_subject_key" text,
	"introducing_sha" char(40) NOT NULL,
	"file_path" text,
	"line_start" integer,
	"line_end" integer,
	"files_in_introducing_commit" integer,
	"project_age_days_at_introduction" integer,
	"introduced_alone" boolean,
	"looks_scaffold_generated" boolean,
	"signals" jsonb,
	"rank_score" numeric(8, 4),
	"status" text DEFAULT 'pending' NOT NULL,
	"dismissed_reason" text,
	"dismissed_note" text,
	"detector_version" integer NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"asked_at" timestamp with time zone,
	"answered_at" timestamp with time zone,
	CONSTRAINT "candidates_dedupe_unq" UNIQUE("repo_id","kind","subject_key","introducing_sha","detector_version"),
	CONSTRAINT "candidates_kind" CHECK ("candidates"."kind" IN ('replacement', 'removal', 'revert', 'scaffold_divergence', 'dependency_choice', 'structural_pattern')),
	CONSTRAINT "candidates_status" CHECK ("candidates"."status" IN ('pending', 'queued', 'asked', 'answered_decision', 'answered_gap', 'dismissed', 'expired')),
	CONSTRAINT "candidates_dismissed_reason" CHECK ("candidates"."dismissed_reason" IS NULL OR "candidates"."dismissed_reason" IN ('not_my_choice', 'not_a_choice', 'not_load_bearing', 'other'))
);
--> statement-breakpoint
CREATE TABLE "commit_sightings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"sha" char(40) NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL,
	"webhook_delivery_id" uuid,
	CONSTRAINT "commit_sightings_repo_sha_unq" UNIQUE("repo_id","sha"),
	CONSTRAINT "commit_sightings_source" CHECK ("commit_sightings"."source" IN ('webhook', 'backfill', 'manual_import'))
);
--> statement-breakpoint
CREATE TABLE "commits" (
	"repo_id" uuid NOT NULL,
	"sha" char(40) NOT NULL,
	"authored_at" timestamp with time zone,
	"committed_at" timestamp with time zone,
	"author_email" "citext",
	"author_name" text,
	"subject" text,
	"parent_count" smallint,
	"insertions" integer,
	"deletions" integer,
	"files_changed" integer,
	CONSTRAINT "commits_repo_id_sha_pk" PRIMARY KEY("repo_id","sha")
);
--> statement-breakpoint
CREATE TABLE "decision_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"decision_id" uuid NOT NULL,
	"revision_no" integer NOT NULL,
	"context" text,
	"options_considered" text,
	"choice" text,
	"cost" text,
	"revisit_condition" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "decision_revisions_no_unq" UNIQUE("decision_id","revision_no")
);
--> statement-breakpoint
CREATE TABLE "decision_skills" (
	"decision_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"level_implied" smallint,
	"source" text NOT NULL,
	"confidence" numeric(4, 3),
	CONSTRAINT "decision_skills_decision_id_skill_id_pk" PRIMARY KEY("decision_id","skill_id"),
	CONSTRAINT "decision_skills_source" CHECK ("decision_skills"."source" IN ('llm', 'user', 'rule'))
);
--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"repo_id" uuid,
	"candidate_id" uuid,
	"origin" text NOT NULL,
	"anchor_sha" char(40),
	"anchor_path" text,
	"anchor_line_start" integer,
	"anchor_line_end" integer,
	"context" text,
	"options_considered" text,
	"choice" text,
	"cost" text,
	"revisit_condition" text,
	"cost_names_loss" boolean,
	"cost_is_system_specific" boolean,
	"cost_check_version" integer,
	"cost_checked_at" timestamp with time zone,
	"cost_feedback" text,
	"provenance" text DEFAULT 'retrospective' NOT NULL,
	"anchor_first_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "decisions_candidate_id_unique" UNIQUE("candidate_id"),
	CONSTRAINT "decisions_origin" CHECK ("decisions"."origin" IN ('authored_in_repo', 'prompted_by_detection', 'entered_manually')),
	CONSTRAINT "decisions_provenance" CHECK ("decisions"."provenance" IN ('pre_registered', 'retrospective'))
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"repo_id" uuid,
	"sha" char(40) NOT NULL,
	"file_path" text,
	"line_start" integer,
	"line_end" integer,
	"kind" text NOT NULL,
	"shows" text,
	"decision_id" uuid,
	"learning_goal_id" uuid,
	"skill_claim_id" uuid,
	"verification_status" text DEFAULT 'verified' NOT NULL,
	"last_verified_at" timestamp with time zone,
	"broken_at" timestamp with time zone,
	"broken_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_exactly_one_target" CHECK ((
        ("evidence"."decision_id" IS NOT NULL)::int
        + ("evidence"."learning_goal_id" IS NOT NULL)::int
        + ("evidence"."skill_claim_id" IS NOT NULL)::int
      ) = 1),
	CONSTRAINT "evidence_kind" CHECK ("evidence"."kind" IN ('introducing_commit', 'replacement', 'revert', 'config', 'test', 'benchmark', 'debug_session')),
	CONSTRAINT "evidence_verification_status" CHECK ("evidence"."verification_status" IN ('verified', 'stale', 'broken', 'unverifiable')),
	CONSTRAINT "evidence_broken_reason" CHECK ("evidence"."broken_reason" IS NULL OR "evidence"."broken_reason" IN ('repo_deleted', 'history_rewritten', 'path_gone', 'sha_missing'))
);
--> statement-breakpoint
CREATE TABLE "installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"github_installation_id" bigint NOT NULL,
	"account_login" text NOT NULL,
	"account_type" text NOT NULL,
	"user_id" uuid NOT NULL,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"suspended_at" timestamp with time zone,
	"uninstalled_at" timestamp with time zone,
	CONSTRAINT "installations_github_installation_id_unique" UNIQUE("github_installation_id")
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "jobs_status" CHECK ("jobs"."status" IN ('queued', 'running', 'succeeded', 'failed', 'dead'))
);
--> statement-breakpoint
CREATE TABLE "learning_goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"skill_id" uuid,
	"candidate_id" uuid,
	"title" text NOT NULL,
	"note" text,
	"status" text DEFAULT 'open' NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "learning_goals_status" CHECK ("learning_goals"."status" IN ('open', 'in_progress', 'done', 'abandoned'))
);
--> statement-breakpoint
CREATE TABLE "repos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" uuid NOT NULL,
	"github_repo_id" bigint NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"is_private" boolean NOT NULL,
	"default_branch" text NOT NULL,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disconnected_at" timestamp with time zone,
	"backfill_status" text DEFAULT 'pending' NOT NULL,
	"last_push_seen_at" timestamp with time zone,
	CONSTRAINT "repos_github_repo_id_unique" UNIQUE("github_repo_id"),
	CONSTRAINT "repos_backfill_status" CHECK ("repos"."backfill_status" IN ('pending', 'running', 'complete', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "skill_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"skill_id" uuid NOT NULL,
	"alias" "citext" NOT NULL,
	CONSTRAINT "skill_aliases_alias_unique" UNIQUE("alias")
);
--> statement-breakpoint
CREATE TABLE "skill_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"level_ordinal" smallint NOT NULL,
	"status" text DEFAULT 'claimed' NOT NULL,
	"first_evidenced_at" timestamp with time zone,
	"last_evidenced_at" timestamp with time zone,
	CONSTRAINT "skill_claims_unq" UNIQUE("user_id","skill_id","level_ordinal"),
	CONSTRAINT "skill_claims_status" CHECK ("skill_claims"."status" IN ('verified', 'claimed'))
);
--> statement-breakpoint
CREATE TABLE "skill_levels" (
	"ordinal" smallint PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"definition" text NOT NULL,
	"required_evidence_kind" text,
	CONSTRAINT "skill_levels_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skills_slug_unique" UNIQUE("slug"),
	CONSTRAINT "skills_kind" CHECK ("skills"."kind" IN ('technology', 'language', 'concept', 'practice'))
);
--> statement-breakpoint
CREATE TABLE "user_git_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"email" "citext" NOT NULL,
	"confirmed_via" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_git_identities_email_unq" UNIQUE("email"),
	CONSTRAINT "user_git_identities_confirmed_via" CHECK ("user_git_identities"."confirmed_via" IN ('github_verified', 'user_asserted'))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"github_user_id" bigint NOT NULL,
	"login" text NOT NULL,
	"name" text,
	"avatar_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_github_user_id_unique" UNIQUE("github_user_id")
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"github_delivery_id" text NOT NULL,
	"event" text NOT NULL,
	"signature_valid" boolean NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb,
	"processed_at" timestamp with time zone,
	"error" text,
	CONSTRAINT "webhook_deliveries_github_delivery_id_unique" UNIQUE("github_delivery_id")
);
--> statement-breakpoint
ALTER TABLE "analysis_cache" ADD CONSTRAINT "analysis_cache_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commit_sightings" ADD CONSTRAINT "commit_sightings_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commit_sightings" ADD CONSTRAINT "commit_sightings_webhook_delivery_id_webhook_deliveries_id_fk" FOREIGN KEY ("webhook_delivery_id") REFERENCES "public"."webhook_deliveries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commits" ADD CONSTRAINT "commits_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_revisions" ADD CONSTRAINT "decision_revisions_decision_id_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_skills" ADD CONSTRAINT "decision_skills_decision_id_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_skills" ADD CONSTRAINT "decision_skills_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_skills" ADD CONSTRAINT "decision_skills_level_implied_skill_levels_ordinal_fk" FOREIGN KEY ("level_implied") REFERENCES "public"."skill_levels"("ordinal") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_decision_id_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_learning_goal_id_learning_goals_id_fk" FOREIGN KEY ("learning_goal_id") REFERENCES "public"."learning_goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_skill_claim_id_skill_claims_id_fk" FOREIGN KEY ("skill_claim_id") REFERENCES "public"."skill_claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installations" ADD CONSTRAINT "installations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_goals" ADD CONSTRAINT "learning_goals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_goals" ADD CONSTRAINT "learning_goals_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_goals" ADD CONSTRAINT "learning_goals_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_installation_id_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_aliases" ADD CONSTRAINT "skill_aliases_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_claims" ADD CONSTRAINT "skill_claims_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_claims" ADD CONSTRAINT "skill_claims_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_claims" ADD CONSTRAINT "skill_claims_level_ordinal_skill_levels_ordinal_fk" FOREIGN KEY ("level_ordinal") REFERENCES "public"."skill_levels"("ordinal") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_git_identities" ADD CONSTRAINT "user_git_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "analysis_cache_sha_idx" ON "analysis_cache" USING btree ("repo_id","sha");--> statement-breakpoint
CREATE INDEX "candidates_ask_budget_idx" ON "candidates" USING btree ("user_id","rank_score" DESC NULLS LAST) WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "commits_author_email_idx" ON "commits" USING btree ("author_email");--> statement-breakpoint
CREATE INDEX "decisions_user_idx" ON "decisions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "evidence_decision_idx" ON "evidence" USING btree ("decision_id");--> statement-breakpoint
CREATE INDEX "evidence_skill_claim_idx" ON "evidence" USING btree ("skill_claim_id");--> statement-breakpoint
CREATE INDEX "jobs_queue_idx" ON "jobs" USING btree ("run_after") WHERE status = 'queued';