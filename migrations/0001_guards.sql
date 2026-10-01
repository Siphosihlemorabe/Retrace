-- Hand-written. Three things Drizzle cannot express, all of which protect
-- claims the product makes rather than merely shaping data.

-- 1. commit_sightings is append-only.
--
-- first_seen_at is the only timestamp in the system that is not derivable from
-- anything else, and the entire "written before the outcome was known" claim
-- rests on it. A comment is not enough protection: the realistic failure is a
-- well-meaning re-backfill that improves author parsing and silently rewrites
-- history. Refuse the UPDATE at the database so that mistake cannot happen
-- from application code, a migration, or a psql session.
CREATE OR REPLACE FUNCTION commit_sightings_no_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'commit_sightings is append-only: first_seen_at is the basis of every verification claim and cannot be reconstructed if overwritten'
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint

CREATE TRIGGER commit_sightings_no_update_trg
BEFORE UPDATE ON commit_sightings
FOR EACH ROW EXECUTE FUNCTION commit_sightings_no_update();
--> statement-breakpoint

-- Deleting a sighting is nearly as destructive. Allowed only via the
-- ON DELETE CASCADE from repos, which is a deliberate disconnection.
CREATE OR REPLACE FUNCTION commit_sightings_no_direct_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM repos WHERE id = OLD.repo_id) THEN
    RAISE EXCEPTION
      'commit_sightings rows are deleted only by disconnecting their repo'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER commit_sightings_no_direct_delete_trg
BEFORE DELETE ON commit_sightings
FOR EACH ROW EXECUTE FUNCTION commit_sightings_no_direct_delete();
--> statement-breakpoint

-- 2. Depth levels.
--
-- Observable definitions, each naming the kind of evidence that proves it.
-- These are an open question in CLAUDE.md, which is exactly why they are rows:
-- refining them should be an UPDATE, not a migration.
INSERT INTO skill_levels (ordinal, slug, name, definition, required_evidence_kind) VALUES
  (1, 'used_it', 'Used it',
   'The technology appears in work they authored. Says nothing about depth.',
   'introducing_commit'),
  (2, 'configured_beyond_defaults', 'Configured beyond defaults',
   'They changed generated config, or hand-wrote something the framework offers, in a way that shows they read past the happy path.',
   'config'),
  (3, 'recorded_tradeoff', 'Made a recorded tradeoff',
   'A decision record naming a cost specific to this system, anchored to the code it shaped.',
   'replacement'),
  (4, 'debugged_system_specific', 'Debugged something system-specific',
   'They diagnosed a failure that could not be resolved by general knowledge of the technology alone.',
   'debug_session')
ON CONFLICT (ordinal) DO NOTHING;
--> statement-breakpoint

-- 3. Verified vs claimed must never drift.
--
-- skill_claims.status is derived, so make the derivation the only way it can be
-- set. A claim is verified when at least one piece of evidence supporting it is
-- still checkable; a broken pointer drops it back to a claim, which is correct
-- behaviour and the reason broken evidence is kept rather than deleted.
CREATE OR REPLACE FUNCTION recompute_skill_claim_status(claim_id uuid)
RETURNS void
LANGUAGE sql
AS $$
  UPDATE skill_claims c
  SET status = CASE WHEN EXISTS (
        SELECT 1 FROM evidence e
        WHERE e.skill_claim_id = c.id
          AND e.verification_status IN ('verified', 'stale')
      ) THEN 'verified' ELSE 'claimed' END,
      first_evidenced_at = (
        SELECT min(e.created_at) FROM evidence e
        WHERE e.skill_claim_id = c.id
          AND e.verification_status IN ('verified', 'stale')
      ),
      last_evidenced_at = (
        SELECT max(e.created_at) FROM evidence e
        WHERE e.skill_claim_id = c.id
          AND e.verification_status IN ('verified', 'stale')
      )
  WHERE c.id = claim_id;
$$;
