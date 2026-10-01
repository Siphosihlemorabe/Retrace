import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Case-insensitive text. Requires `CREATE EXTENSION citext` (in 0001_guards.sql).
 * Used for anything matched against human-entered or git-config-entered strings,
 * where casing carries no meaning and a mismatch would silently lose an association.
 */
const citext = customType<{ data: string }>({
  dataType: () => 'citext',
});

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

/**
 * Values allowed in a `text` + CHECK column.
 *
 * Emitted as SQL literals, not `sql\`${v}\``: interpolation becomes a bind
 * parameter, which is right in a query and invalid in DDL — it generated
 * `IN ($1, $2)` constraints that Postgres refuses to create. The values are
 * compile-time constants, but quotes are escaped anyway so this stays safe if
 * that ever stops being true.
 */
const oneOf = (column: unknown, values: readonly string[]) =>
  sql`${column} IN (${sql.raw(
    values.map((v) => `'${v.replaceAll("'", "''")}'`).join(', '),
  )})`;

// ---------------------------------------------------------------------------
// Identity and attribution
// ---------------------------------------------------------------------------

export const users = pgTable('users', {
  id: id(),
  githubUserId: bigint('github_user_id', { mode: 'number' }).notNull().unique(),
  login: text('login').notNull(),
  name: text('name'),
  avatarUrl: text('avatar_url'),
  createdAt: createdAt(),
});

/**
 * The git author identities that belong to this user.
 *
 * Attribution in monorepos and team repos runs through here: a commit is the
 * user's when `commits.author_email` is in their identity set. Without this,
 * every commit in a shared repo would look like evidence of their work.
 */
export const userGitIdentities = pgTable(
  'user_git_identities',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    email: citext('email').notNull(),
    confirmedVia: text('confirmed_via').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('user_git_identities_email_unq').on(t.email),
    check(
      'user_git_identities_confirmed_via',
      oneOf(t.confirmedVia, ['github_verified', 'user_asserted']),
    ),
  ],
);

export const installations = pgTable('installations', {
  id: id(),
  githubInstallationId: bigint('github_installation_id', { mode: 'number' })
    .notNull()
    .unique(),
  accountLogin: text('account_login').notNull(),
  accountType: text('account_type').notNull(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  installedAt: timestamp('installed_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  suspendedAt: timestamp('suspended_at', { withTimezone: true }),
  uninstalledAt: timestamp('uninstalled_at', { withTimezone: true }),
});

export const repos = pgTable(
  'repos',
  {
    id: id(),
    installationId: uuid('installation_id')
      .notNull()
      .references(() => installations.id, { onDelete: 'cascade' }),
    githubRepoId: bigint('github_repo_id', { mode: 'number' }).notNull().unique(),
    owner: text('owner').notNull(),
    name: text('name').notNull(),
    isPrivate: boolean('is_private').notNull(),
    defaultBranch: text('default_branch').notNull(),

    /**
     * Server clock, set once. The boundary of the trust claim: anything whose
     * first sighting predates this is retrospective and weaker evidence, and
     * the profile has to show that. Never update this column.
     */
    connectedAt: timestamp('connected_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    disconnectedAt: timestamp('disconnected_at', { withTimezone: true }),

    backfillStatus: text('backfill_status').notNull().default('pending'),
    lastPushSeenAt: timestamp('last_push_seen_at', { withTimezone: true }),
  },
  (t) => [
    check(
      'repos_backfill_status',
      oneOf(t.backfillStatus, ['pending', 'running', 'complete', 'failed']),
    ),
  ],
);

/** Web sign-in sessions. Named `auth_` so `practice_sessions` stays free. */
export const authSessions = pgTable('auth_sessions', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// Trust ledger — append-only. Nothing here is derivable from anything else.
// ---------------------------------------------------------------------------

export const webhookDeliveries = pgTable('webhook_deliveries', {
  id: id(),
  githubDeliveryId: text('github_delivery_id').notNull().unique(),
  event: text('event').notNull(),
  signatureValid: boolean('signature_valid').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  payload: jsonb('payload'),
  processedAt: timestamp('processed_at', { withTimezone: true }),
  error: text('error'),
});

/**
 * When our server first saw a commit. The single load-bearing timestamp in the
 * product — git's own dates can be set to anything and history can be rewritten,
 * so this is the only evidence that something was written before an outcome was
 * known.
 *
 * It is a separate table from `commits` on purpose. `commits` is a cache that
 * gets rebuilt whenever parsing improves; if `first_seen_at` lived there, a
 * well-meaning re-backfill would silently overwrite it and there would be no way
 * to notice or recover. A BEFORE UPDATE trigger in 0001_guards.sql enforces
 * append-only at the database.
 */
export const commitSightings = pgTable(
  'commit_sightings',
  {
    id: id(),
    repoId: uuid('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    sha: char('sha', { length: 40 }).notNull(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    source: text('source').notNull(),
    webhookDeliveryId: uuid('webhook_delivery_id').references(
      () => webhookDeliveries.id,
    ),
  },
  (t) => [
    unique('commit_sightings_repo_sha_unq').on(t.repoId, t.sha),
    check(
      'commit_sightings_source',
      oneOf(t.source, ['webhook', 'backfill', 'manual_import']),
    ),
  ],
);

// ---------------------------------------------------------------------------
// Derivable cache — safe to TRUNCATE and rebuild from the clone.
// ---------------------------------------------------------------------------

export const commits = pgTable(
  'commits',
  {
    repoId: uuid('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    sha: char('sha', { length: 40 }).notNull(),

    /** Git's own dates. Attacker-controlled; never use them for a trust claim. */
    authoredAt: timestamp('authored_at', { withTimezone: true }),
    committedAt: timestamp('committed_at', { withTimezone: true }),

    authorEmail: citext('author_email'),
    authorName: text('author_name'),
    subject: text('subject'),
    parentCount: smallint('parent_count'),
    insertions: integer('insertions'),
    deletions: integer('deletions'),
    filesChanged: integer('files_changed'),
  },
  (t) => [
    primaryKey({ columns: [t.repoId, t.sha] }),
    index('commits_author_email_idx').on(t.authorEmail),
  ],
);

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export const candidates = pgTable(
  'candidates',
  {
    id: id(),
    repoId: uuid('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    kind: text('kind').notNull(),

    /** What the choice is about, e.g. ('dependency', 'npm:prisma'). */
    subjectKind: text('subject_kind').notNull(),
    subjectKey: text('subject_key').notNull(),
    /** For replacements: what it displaced. The strongest signal we have. */
    displacedSubjectKey: text('displaced_subject_key'),

    introducingSha: char('introducing_sha', { length: 40 }).notNull(),
    filePath: text('file_path'),
    lineStart: integer('line_start'),
    lineEnd: integer('line_end'),

    /**
     * Deliberateness evidence, answerable from the introducing diff alone.
     * Promoted out of `signals` because ranking reads them on every query.
     */
    filesInIntroducingCommit: integer('files_in_introducing_commit'),
    projectAgeDaysAtIntroduction: integer('project_age_days_at_introduction'),
    introducedAlone: boolean('introduced_alone'),
    looksScaffoldGenerated: boolean('looks_scaffold_generated'),

    signals: jsonb('signals'),
    rankScore: numeric('rank_score', { precision: 8, scale: 4 }),

    status: text('status').notNull().default('pending'),

    /**
     * Maps one-to-one onto the three tests. This is the only feedback loop for
     * tuning the riskiest part of the product, so it is a constrained column
     * rather than free text.
     */
    dismissedReason: text('dismissed_reason'),
    dismissedNote: text('dismissed_note'),

    detectorVersion: integer('detector_version').notNull(),
    detectedAt: timestamp('detected_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    askedAt: timestamp('asked_at', { withTimezone: true }),
    answeredAt: timestamp('answered_at', { withTimezone: true }),
  },
  (t) => [
    unique('candidates_dedupe_unq').on(
      t.repoId,
      t.kind,
      t.subjectKey,
      t.introducingSha,
      t.detectorVersion,
    ),
    check(
      'candidates_kind',
      oneOf(t.kind, [
        'replacement',
        // A dependency dropped with nothing in its place. Its own kind rather
        // than a dependency_choice: it asks "why did you drop X?", carries its
        // own rank bonus, and calibration has to count it separately.
        'removal',
        'revert',
        'scaffold_divergence',
        'dependency_choice',
        'structural_pattern',
      ]),
    ),
    check(
      'candidates_status',
      oneOf(t.status, [
        'pending',
        'queued',
        'asked',
        'answered_decision',
        'answered_gap',
        'dismissed',
        'expired',
      ]),
    ),
    check(
      'candidates_dismissed_reason',
      sql`${t.dismissedReason} IS NULL OR ${oneOf(t.dismissedReason, [
        'not_my_choice',
        'not_a_choice',
        'not_load_bearing',
        'other',
      ])}`,
    ),
    // The weekly ask budget: highest-ranked pending candidates for one user.
    index('candidates_ask_budget_idx')
      .on(t.userId, t.rankScore.desc())
      .where(sql`status = 'pending'`),
  ],
);

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export const decisions = pgTable(
  'decisions',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    repoId: uuid('repo_id').references(() => repos.id, { onDelete: 'set null' }),
    candidateId: uuid('candidate_id')
      .references(() => candidates.id, { onDelete: 'set null' })
      .unique(),

    origin: text('origin').notNull(),

    anchorSha: char('anchor_sha', { length: 40 }),
    anchorPath: text('anchor_path'),
    anchorLineStart: integer('anchor_line_start'),
    anchorLineEnd: integer('anchor_line_end'),

    /**
     * The shape, from CLAUDE.md: context · options · choice · cost named ·
     * revisit condition. All nullable — this is feedback scaffolding, not a
     * form. A half-filled record is still worth keeping and telling the user
     * what is missing.
     */
    context: text('context'),
    optionsConsidered: text('options_considered'),
    choice: text('choice'),
    cost: text('cost'),
    revisitCondition: text('revisit_condition'),

    /** Cost quality: does it name something lost, specific to this system? */
    costNamesLoss: boolean('cost_names_loss'),
    costIsSystemSpecific: boolean('cost_is_system_specific'),
    costCheckVersion: integer('cost_check_version'),
    costCheckedAt: timestamp('cost_checked_at', { withTimezone: true }),
    costFeedback: text('cost_feedback'),

    /**
     * 'pre_registered' only when the record was created before the anchor
     * commit's first sighting AND that sighting came from a webhook. Under
     * full-history backfill almost everything starts out 'retrospective';
     * that is the honest answer, not a problem to design around.
     */
    provenance: text('provenance').notNull().default('retrospective'),
    /** Copied from the sighting at insert. Immutable; denormalised to keep the
     * provenance claim readable without a three-table join. */
    anchorFirstSeenAt: timestamp('anchor_first_seen_at', { withTimezone: true }),

    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      'decisions_origin',
      oneOf(t.origin, [
        'authored_in_repo',
        'prompted_by_detection',
        'entered_manually',
      ]),
    ),
    check(
      'decisions_provenance',
      oneOf(t.provenance, ['pre_registered', 'retrospective']),
    ),
    index('decisions_user_idx').on(t.userId, t.createdAt),
  ],
);

/**
 * Every prior version of the five shape fields.
 *
 * Without this, `provenance = 'pre_registered'` is unfalsifiable: you could
 * rewrite the text once the outcome was known and nothing would show it. The
 * cost-quality check actively invites revision, so this is not hypothetical.
 */
export const decisionRevisions = pgTable(
  'decision_revisions',
  {
    id: id(),
    decisionId: uuid('decision_id')
      .notNull()
      .references(() => decisions.id, { onDelete: 'cascade' }),
    revisionNo: integer('revision_no').notNull(),
    context: text('context'),
    optionsConsidered: text('options_considered'),
    choice: text('choice'),
    cost: text('cost'),
    revisitCondition: text('revisit_condition'),
    createdAt: createdAt(),
  },
  (t) => [unique('decision_revisions_no_unq').on(t.decisionId, t.revisionNo)],
);

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

export const skills = pgTable(
  'skills',
  {
    id: id(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      'skills_kind',
      oneOf(t.kind, ['technology', 'language', 'concept', 'practice']),
    ),
  ],
);

/**
 * Naming only: Postgres / PostgreSQL / postgres resolve to one node.
 *
 * Deliberately does NOT express Postgres -> SQL. That is transfer, it needs
 * weights nobody can justify yet, and a `skill_edges` table is purely additive
 * when there is finally something to weight.
 */
export const skillAliases = pgTable('skill_aliases', {
  id: id(),
  skillId: uuid('skill_id')
    .notNull()
    .references(() => skills.id, { onDelete: 'cascade' }),
  alias: citext('alias').notNull().unique(),
});

/**
 * Depth levels, as data rather than an enum — their definitions are an open
 * question in CLAUDE.md and will change. Each level names the kind of evidence
 * that proves it; a level with no such evidence is a claim, not a verification.
 * Seeded in 0001_guards.sql.
 */
export const skillLevels = pgTable('skill_levels', {
  ordinal: smallint('ordinal').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  definition: text('definition').notNull(),
  requiredEvidenceKind: text('required_evidence_kind'),
});

export const skillClaims = pgTable(
  'skill_claims',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    skillId: uuid('skill_id')
      .notNull()
      .references(() => skills.id, { onDelete: 'cascade' }),
    levelOrdinal: smallint('level_ordinal')
      .notNull()
      .references(() => skillLevels.ordinal),

    /**
     * Derived from whether any non-broken evidence supports this claim, and
     * recomputed — never hand-set. This column is the verified/claim boundary
     * that CLAUDE.md says must never blur.
     */
    status: text('status').notNull().default('claimed'),
    firstEvidencedAt: timestamp('first_evidenced_at', { withTimezone: true }),
    lastEvidencedAt: timestamp('last_evidenced_at', { withTimezone: true }),
  },
  (t) => [
    unique('skill_claims_unq').on(t.userId, t.skillId, t.levelOrdinal),
    check('skill_claims_status', oneOf(t.status, ['verified', 'claimed'])),
  ],
);

export const decisionSkills = pgTable(
  'decision_skills',
  {
    decisionId: uuid('decision_id')
      .notNull()
      .references(() => decisions.id, { onDelete: 'cascade' }),
    skillId: uuid('skill_id')
      .notNull()
      .references(() => skills.id, { onDelete: 'cascade' }),
    levelImplied: smallint('level_implied').references(() => skillLevels.ordinal),
    source: text('source').notNull(),
    confidence: numeric('confidence', { precision: 4, scale: 3 }),
  },
  (t) => [
    primaryKey({ columns: [t.decisionId, t.skillId] }),
    check('decision_skills_source', oneOf(t.source, ['llm', 'user', 'rule'])),
  ],
);

// ---------------------------------------------------------------------------
// Learning goals — the detector's other answer, and not a failure
// ---------------------------------------------------------------------------

export const learningGoals = pgTable(
  'learning_goals',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    skillId: uuid('skill_id').references(() => skills.id, {
      onDelete: 'set null',
    }),
    /** Set when this came from an "I didn't know that was a choice" answer. */
    candidateId: uuid('candidate_id').references(() => candidates.id, {
      onDelete: 'set null',
    }),
    title: text('title').notNull(),
    note: text('note'),
    status: text('status').notNull().default('open'),
    openedAt: timestamp('opened_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [
    check(
      'learning_goals_status',
      oneOf(t.status, ['open', 'in_progress', 'done', 'abandoned']),
    ),
  ],
);

// ---------------------------------------------------------------------------
// Evidence — pointers, never code
// ---------------------------------------------------------------------------

/**
 * A small row saying "this commit, this file, these lines, and what it shows".
 * Kilobytes, not repositories, and nobody has to hand over private source.
 *
 * A broken pointer is never deleted. If the repo is gone or the history was
 * rewritten, the status flips and whatever it supported drops back to a claim.
 * That is correct behaviour: deleting the row would silently make the profile
 * look better than it is.
 */
export const evidence = pgTable(
  'evidence',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    repoId: uuid('repo_id').references(() => repos.id, { onDelete: 'set null' }),

    sha: char('sha', { length: 40 }).notNull(),
    filePath: text('file_path'),
    lineStart: integer('line_start'),
    lineEnd: integer('line_end'),

    kind: text('kind').notNull(),
    /** What this pointer demonstrates, in the user's own words. */
    shows: text('shows'),

    decisionId: uuid('decision_id').references(() => decisions.id, {
      onDelete: 'cascade',
    }),
    learningGoalId: uuid('learning_goal_id').references(() => learningGoals.id, {
      onDelete: 'cascade',
    }),
    skillClaimId: uuid('skill_claim_id').references(() => skillClaims.id, {
      onDelete: 'cascade',
    }),

    verificationStatus: text('verification_status').notNull().default('verified'),
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
    brokenAt: timestamp('broken_at', { withTimezone: true }),
    brokenReason: text('broken_reason'),

    createdAt: createdAt(),
  },
  (t) => [
    check(
      'evidence_exactly_one_target',
      sql`(
        (${t.decisionId} IS NOT NULL)::int
        + (${t.learningGoalId} IS NOT NULL)::int
        + (${t.skillClaimId} IS NOT NULL)::int
      ) = 1`,
    ),
    check(
      'evidence_kind',
      oneOf(t.kind, [
        'introducing_commit',
        'replacement',
        'revert',
        'config',
        'test',
        'benchmark',
        'debug_session',
      ]),
    ),
    check(
      'evidence_verification_status',
      oneOf(t.verificationStatus, [
        'verified',
        'stale',
        'broken',
        'unverifiable',
      ]),
    ),
    check(
      'evidence_broken_reason',
      sql`${t.brokenReason} IS NULL OR ${oneOf(t.brokenReason, [
        'repo_deleted',
        'history_rewritten',
        'path_gone',
        'sha_missing',
      ])}`,
    ),
    index('evidence_decision_idx').on(t.decisionId),
    index('evidence_skill_claim_idx').on(t.skillClaimId),
  ],
);

// ---------------------------------------------------------------------------
// Infrastructure
// ---------------------------------------------------------------------------

/**
 * LLM results, so the same code is never analysed twice.
 *
 * `cache_key` must hash the prompt and analysis versions alongside the SHA.
 * Keying on SHA alone would serve results from a superseded prompt forever,
 * with no way to tell that is what happened.
 */
export const analysisCache = pgTable(
  'analysis_cache',
  {
    id: id(),
    cacheKey: text('cache_key').notNull().unique(),
    kind: text('kind').notNull(),
    repoId: uuid('repo_id').references(() => repos.id, { onDelete: 'cascade' }),
    sha: char('sha', { length: 40 }),
    promptVersion: integer('prompt_version').notNull(),
    analysisVersion: integer('analysis_version').notNull(),
    model: text('model').notNull(),
    result: jsonb('result').notNull(),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    cacheReadTokens: integer('cache_read_tokens'),
    createdAt: createdAt(),
  },
  (t) => [index('analysis_cache_sha_idx').on(t.repoId, t.sha)],
);

export const jobs = pgTable(
  'jobs',
  {
    id: id(),
    kind: text('kind').notNull(),
    payload: jsonb('payload'),
    status: text('status').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    runAfter: timestamp('run_after', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedBy: text('locked_by'),
    lastError: text('last_error'),
    createdAt: createdAt(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    check(
      'jobs_status',
      oneOf(t.status, ['queued', 'running', 'succeeded', 'failed', 'dead']),
    ),
    // Drain order. FOR UPDATE SKIP LOCKED reads through this.
    index('jobs_queue_idx')
      .on(t.runAfter)
      .where(sql`status = 'queued'`),
  ],
);
