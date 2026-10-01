-- Hand-written. decisions.role is copied at insert and never updated (0003).
--
-- 'kept' (understood an agent's choice and kept it) and 'made' (made the
-- choice) are different claims, and the gap between them is exactly what a
-- profile must not blur (G4). The realistic failure is an "edit decision" path
-- that rewrites every column it was given, role included. Refuse it at the
-- database, the same way commit_sightings refuses rewrites in 0001_guards.
CREATE OR REPLACE FUNCTION decisions_role_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    RAISE EXCEPTION
      'decisions.role is immutable: made, directed and kept are different claims, and one cannot be turned into another after the fact'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER decisions_role_immutable_trg
BEFORE UPDATE OF role ON decisions
FOR EACH ROW EXECUTE FUNCTION decisions_role_immutable();
