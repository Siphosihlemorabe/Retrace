CREATE TABLE "llm_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"provider" text NOT NULL,
	"model" text,
	"cache_key" text NOT NULL,
	"cache_hit" boolean NOT NULL,
	"ok" boolean NOT NULL,
	"error" text,
	"duration_ms" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd" numeric(10, 6),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "practice_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"answer" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"target_kind" text NOT NULL,
	"sighting_id" uuid,
	"outcome_id" uuid,
	"candidate_id" uuid,
	"text" text NOT NULL,
	"sha" char(40),
	"path" text,
	"line_start" integer,
	"line_end" integer,
	"key_points" jsonb,
	"found_by" text NOT NULL,
	"prompt_version" integer NOT NULL,
	"provider" text,
	"model" text,
	"cache_key" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"skip_count" smallint DEFAULT 0 NOT NULL,
	"shown_at" timestamp with time zone,
	"answered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "questions_target_kind" CHECK ("questions"."target_kind" IN ('outcome_sighting', 'outcome_untouched', 'candidate')),
	CONSTRAINT "questions_one_target" CHECK ((
        ("questions"."target_kind" = 'outcome_sighting' AND "questions"."sighting_id" IS NOT NULL AND "questions"."candidate_id" IS NULL)
        OR ("questions"."target_kind" = 'outcome_untouched' AND "questions"."outcome_id" IS NOT NULL AND "questions"."sighting_id" IS NULL AND "questions"."candidate_id" IS NULL)
        OR ("questions"."target_kind" = 'candidate' AND "questions"."candidate_id" IS NOT NULL AND "questions"."sighting_id" IS NULL)
      )),
	CONSTRAINT "questions_found_by" CHECK ("questions"."found_by" IN ('model', 'rule')),
	CONSTRAINT "questions_status" CHECK ("questions"."status" IN ('pending', 'answered', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "user_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"questions_per_week" smallint DEFAULT 3 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_settings_questions_per_week" CHECK ("user_settings"."questions_per_week" BETWEEN 3 AND 50)
);
--> statement-breakpoint
ALTER TABLE "outcome_sightings" ADD COLUMN "written_after_goal" boolean;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "llm_allowed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "skill_outcomes" ADD COLUMN "look_for" jsonb;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practice_answers" ADD CONSTRAINT "practice_answers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practice_answers" ADD CONSTRAINT "practice_answers_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_sighting_id_outcome_sightings_id_fk" FOREIGN KEY ("sighting_id") REFERENCES "public"."outcome_sightings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_outcome_id_skill_outcomes_id_fk" FOREIGN KEY ("outcome_id") REFERENCES "public"."skill_outcomes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "llm_calls_user_day_idx" ON "llm_calls" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "questions_sighting_unq" ON "questions" USING btree ("user_id","sighting_id") WHERE sighting_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "questions_candidate_unq" ON "questions" USING btree ("user_id","candidate_id") WHERE candidate_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "questions_untouched_unq" ON "questions" USING btree ("user_id","repo_id","outcome_id") WHERE target_kind = 'outcome_untouched';--> statement-breakpoint
CREATE INDEX "questions_user_shown_idx" ON "questions" USING btree ("user_id","shown_at");