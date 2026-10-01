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
  uniqueIndex,
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

/**
 * Author identities this user has said are *not* them (0003, "[o] Someone
 * else"), so the identity question is never asked twice.
 *
 * A table rather than a column on `user_git_identities`: that table's rows mean
 * "this email is this user", and a not-me row has no user to point at. Keyed
 * per user because "not me" is one person's statement, and it is the first
 * shape team attribution will need.
 */
export const knownOtherIdentities = pgTable(
  'known_other_identities',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    email: citext('email').notNull(),
    name: text('name'),
    createdAt: createdAt(),
  },
  (t) => [unique('known_other_identities_unq').on(t.userId, t.email)],
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

    /**
     * Where this repo's data came from. A local clone has no installation and
     * no GitHub id, and inventing them would be a lie in the one product whose
     * claim is telling verified from asserted (0002, "local repos in a
     * GitHub-shaped schema"). The GitHub columns are nullable only for local
     * clones — see `repos_github_fields` below.
     */
    source: text('source').notNull().default('github'),

    installationId: uuid('installation_id').references(() => installations.id, {
      onDelete: 'cascade',
    }),
    githubRepoId: bigint('github_repo_id', { mode: 'number' }).unique(),
    owner: text('owner'),
    name: text('name').notNull(),
    isPrivate: boolean('is_private'),
    defaultBranch: text('default_branch').notNull(),

    /**
     * Local clones are identified by absolute path + root commit SHA. The path
     * alone breaks when two directories hold different repos over time; the
     * root SHA alone merges two clones of one repo that may have diverged.
     */
    localPath: text('local_path'),
    rootSha: char('root_sha', { length: 40 }),

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
    check('repos_source', oneOf(t.source, ['github', 'local_clone'])),
    check(
      'repos_github_fields',
      sql`${t.source} <> 'github' OR (
        ${t.installationId} IS NOT NULL
        AND ${t.githubRepoId} IS NOT NULL
        AND ${t.owner} IS NOT NULL
        AND ${t.isPrivate} IS NOT NULL
      )`,
    ),
    check(
      'repos_local_clone_fields',
      sql`${t.source} <> 'local_clone' OR (
        ${t.localPath} IS NOT NULL AND ${t.rootSha} IS NOT NULL
      )`,
    ),
    uniqueIndex('repos_local_clone_unq')
      .on(t.localPath, t.rootSha)
      .where(sql`source = 'local_clone'`),
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
      oneOf(t.source, ['webhook', 'backfill', 'manual_import', 'local_scan']),
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
    /**
     * No longer written (0003). Derived from git dates, which are fiction in
     * practice — every Lovable root commit is dated 2025-01-01. Kept only
     * because 0000 is treated as applied; replaced by the commit position below.
     */
    projectAgeDaysAtIntroduction: integer('project_age_days_at_introduction'),
    introducedAlone: boolean('introduced_alone'),
    looksScaffoldGenerated: boolean('looks_scaffold_generated'),

    /** "Commit 5 of 482": topological position, immune to rewritten dates. */
    commitIndexAtIntroduction: integer('commit_index_at_introduction'),
    commitCountAtDetection: integer('commit_count_at_detection'),

    /**
     * Who made the change (0003). Decides how the question is framed: nobody
     * is asked to defend a choice their agent or template made as if it were
     * theirs (G4). A judgement, so it carries the version that made it.
     */
    introducedBy: text('introduced_by').notNull(),
    introducingAuthorEmail: citext('introducing_author_email'),
    authorshipVersion: integer('authorship_version').notNull(),
    /** Set when the builder answers "[a] I asked for it" to an agent frame. */
    authorshipDisputedAt: timestamp('authorship_disputed_at', {
      withTimezone: true,
    }),

    /** Skips so far; at three the candidate expires rather than nagging. */
    skipCount: integer('skip_count').notNull().default(0),

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
      'candidates_introduced_by',
      oneOf(t.introducedBy, [
        'builder',
        'builder_with_agent',
        'agent',
        'template',
        'automation',
        'other_human',
        'unknown',
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

    /**
     * The builder's relationship to the choice (0003): `made` it, `directed`
     * their agent to make it, or `kept` an agent's choice after understanding
     * it. `kept` is an honest record, not a lesser one — but it must never be
     * shown as `made` (G4). No default, so every writer has to state it;
     * immutable after insert, enforced by trigger in 0003_decisions_role_guard.
     */
    role: text('role').notNull(),

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
    check('decisions_role', oneOf(t.role, ['made', 'directed', 'kept'])),
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

    /**
     * `gap`: "I didn't know that was a choice" (0002). `intent`: a goal the
     * builder set for a project, before or while writing it (0007). For an
     * intent, `opened_at` is when it was declared (server clock) and
     * `declared_at_sha` is HEAD at that moment — the line between code that
     * was already there and code written after the goal.
     */
    kind: text('kind').notNull().default('gap'),
    repoId: uuid('repo_id').references(() => repos.id, { onDelete: 'cascade' }),
    declaredAtSha: char('declared_at_sha', { length: 40 }),
  },
  (t) => [
    check(
      'learning_goals_status',
      oneOf(t.status, ['open', 'in_progress', 'done', 'abandoned']),
    ),
    check('learning_goals_kind', oneOf(t.kind, ['gap', 'intent'])),
    check(
      'learning_goals_intent_fields',
      sql`${t.kind} <> 'intent' OR (
        ${t.repoId} IS NOT NULL AND ${t.skillId} IS NOT NULL AND ${t.declaredAtSha} IS NOT NULL
      )`,
    ),
    // One goal per skill per project; a second "SQL" goal would split the percentage.
    uniqueIndex('learning_goals_intent_unq')
      .on(t.userId, t.repoId, t.skillId)
      .where(sql`kind = 'intent'`),
  ],
);

/**
 * A skill's outcomes (0007): what "learning SQL" breaks into. Built-in lists
 * live in code and are synced here; model-drafted lists the builder reviewed
 * (0009) and lists the builder writes (later) live here too, told apart by
 * `source`.
 */
export const skillOutcomes = pgTable(
  'skill_outcomes',
  {
    id: id(),
    skillId: uuid('skill_id')
      .notNull()
      .references(() => skills.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    ordinal: smallint('ordinal').notNull(),
    source: text('source').notNull().default('builtin'),
    /** Set when an outcome leaves the list; kept so old sightings still resolve. */
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    check('skill_outcomes_source', oneOf(t.source, ['builtin', 'model_reviewed', 'builder'])),
  ],
);

/** Which outcomes are in a goal's objective (0007): the ones the builder ticked. */
export const learningGoalOutcomes = pgTable(
  'learning_goal_outcomes',
  {
    goalId: uuid('goal_id')
      .notNull()
      .references(() => learningGoals.id, { onDelete: 'cascade' }),
    outcomeId: uuid('outcome_id')
      .notNull()
      .references(() => skillOutcomes.id, { onDelete: 'cascade' }),
    inObjective: boolean('in_objective').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.goalId, t.outcomeId] })],
);

/**
 * Every change to an objective, kept. Unticking an outcome after touching it
 * is allowed, and history shows it (0007 §2).
 */
export const learningGoalOutcomeChanges = pgTable('learning_goal_outcome_changes', {
  id: id(),
  goalId: uuid('goal_id')
    .notNull()
    .references(() => learningGoals.id, { onDelete: 'cascade' }),
  outcomeId: uuid('outcome_id')
    .notNull()
    .references(() => skillOutcomes.id, { onDelete: 'cascade' }),
  inObjective: boolean('in_objective').notNull(),
  changedAt: createdAt(),
});

/**
 * Code that touches an outcome (0007): a pointer, never the code (G11).
 *
 * A machine judgement, versioned and recomputable — kept out of `evidence` on
 * purpose (decision 2, chosen by the builder), so a line the agent wrote can
 * never be read as evidence of the builder's skill.
 *
 * `scan_kind`: `commit` for a commit scanned after the goal (the lines it
 * added); `snapshot` for code already present when the goal was set (HEAD at
 * that moment, attributed per line by blame).
 */
export const outcomeSightings = pgTable(
  'outcome_sightings',
  {
    id: id(),
    repoId: uuid('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    outcomeId: uuid('outcome_id')
      .notNull()
      .references(() => skillOutcomes.id, { onDelete: 'cascade' }),
    sha: char('sha', { length: 40 }).notNull(),
    path: text('path').notNull(),
    lineStart: integer('line_start').notNull(),
    lineEnd: integer('line_end').notNull(),
    via: text('via').notNull(),
    foundBy: text('found_by').notNull().default('rule'),
    scanKind: text('scan_kind').notNull(),
    /** Who wrote these lines (0003 classes), from the commit or from blame. */
    authorship: text('authorship').notNull(),
    authorshipVersion: integer('authorship_version').notNull(),
    detectorVersion: integer('detector_version').notNull(),
    seenAt: timestamp('seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('outcome_sightings_unq').on(t.repoId, t.outcomeId, t.sha, t.path, t.lineStart, t.lineEnd),
    check('outcome_sightings_via', oneOf(t.via, ['sql', 'orm', 'config', 'code'])),
    check('outcome_sightings_found_by', oneOf(t.foundBy, ['rule', 'model'])),
    check('outcome_sightings_scan_kind', oneOf(t.scanKind, ['commit', 'snapshot'])),
    check(
      'outcome_sightings_authorship',
      oneOf(t.authorship, [
        'builder',
        'builder_with_agent',
        'agent',
        'template',
        'automation',
        'other_human',
        'unknown',
      ]),
    ),
    check('outcome_sightings_lines', sql`${t.lineStart} >= 1 AND ${t.lineEnd} >= ${t.lineStart}`),
    index('outcome_sightings_repo_outcome_idx').on(t.repoId, t.outcomeId),
  ],
);

/**
 * The builder's own word on who wrote some lines (0007 §4): "an AI wrote
 * this, though I committed it", or the reverse. Overrides blame for exactly
 * these lines at this commit, and is shown as "you said".
 */
export const lineLabels = pgTable(
  'line_labels',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    repoId: uuid('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    sha: char('sha', { length: 40 }).notNull(),
    path: text('path').notNull(),
    lineStart: integer('line_start').notNull(),
    lineEnd: integer('line_end').notNull(),
    label: text('label').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check('line_labels_label', oneOf(t.label, ['agent', 'me'])),
    check('line_labels_lines', sql`${t.lineStart} >= 1 AND ${t.lineEnd} >= ${t.lineStart}`),
    index('line_labels_file_idx').on(t.repoId, t.path),
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
