-- ============================================================
-- 080: Master admin matrix v2 — audit log + master-count guard
--
-- Two new pieces to support /admin/matrix v2 (editable access
-- assignments, master toggle):
--
--   1. assignment_change_log — append-only audit trail for every
--      profile_locations mutation that goes through the new admin
--      routes (and any future route that calls logAssignmentChange).
--      Captures actor, target, location, action, before/after JSONB.
--      Master-only readable; service-role-writable. Never deleted —
--      this is the "who changed what" record for compliance and the
--      "why does Sarah suddenly not have access?" debugging path.
--
--   2. private.guard_at_least_one_master — DB trigger on profiles
--      that REJECTS any UPDATE/DELETE that would result in zero
--      active masters platform-wide. Enforced for: role demotion
--      ('master' → anything else), soft-delete (active=true → false
--      on a master row), hard-delete. Defence in depth — the API
--      routes also check the same condition before mutating to give
--      a clean error message, but if a future route author forgets,
--      the trigger still rejects the operation. There must always
--      be at least one active master so the platform can never be
--      orphaned.
--
-- Note on actor coverage: the audit log is written explicitly by the
-- API routes via src/lib/assignment-changes.js#logAssignmentChange.
-- Direct DB writes from the SQL Editor (rare) won't be logged — by
-- design, since the actor would be unknowable from the trigger
-- (auth.uid() is null when called from service_role). Routes that
-- want to be audited must call logAssignmentChange explicitly.
-- ============================================================

BEGIN;

-- ─── assignment_change_log ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS assignment_change_log (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Who performed the change. NULL = service_role / system action
  -- (no human actor). Most rows will have a master's profile id here.
  actor_id            UUID REFERENCES profiles(id) ON DELETE SET NULL,
  -- Who was affected. NOT NULL — every audit entry must name a target.
  target_profile_id   UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  -- Optional — only set for assignment-scoped actions (assignment_create,
  -- assignment_update, assignment_delete). NULL for profile-level actions
  -- (master_promote, master_demote, profile_deactivate).
  location_id         UUID REFERENCES locations(id) ON DELETE SET NULL,
  -- Stable enum-like string. New action types are additive — no CHECK
  -- constraint, just a comment, so app code can introduce new actions
  -- without a migration. Today's set:
  --   assignment_create   — new (profile_locations) row
  --   assignment_update   — role change on existing row
  --   assignment_delete   — row removed (user removed from location)
  --   master_promote      — profiles.role flipped to 'master'
  --   master_demote       — profiles.role flipped from 'master' to per-location role
  --   profile_deactivate  — profiles.active flipped to false
  --   profile_reactivate  — profiles.active flipped back to true
  action              TEXT NOT NULL,
  -- Snapshots of the row state. JSONB so it survives schema evolution
  -- on the source tables. For deletes, after = NULL. For creates,
  -- before = NULL. For updates, both populated.
  before              JSONB,
  after               JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE assignment_change_log IS
  'Append-only audit trail for changes made via /admin/matrix v2 (and any future route that calls src/lib/assignment-changes.js#logAssignmentChange). Master-only readable; service-role writable. Never deleted — this is the compliance / debug record for the question "who changed what when". Direct SQL Editor changes are NOT captured here by design (no actor available outside an authenticated request).';

COMMENT ON COLUMN assignment_change_log.actor_id IS
  'Profile id of the master who performed the change. NULL if performed by service role / system action with no human caller.';

COMMENT ON COLUMN assignment_change_log.action IS
  'Stable enum-like classifier. Today: assignment_create, assignment_update, assignment_delete, master_promote, master_demote, profile_deactivate, profile_reactivate. Add new action types via app code without a migration — no CHECK constraint by design.';

-- Indexes for the most common filter axes on the audit log viewer.
CREATE INDEX IF NOT EXISTS idx_assignment_change_log_target_created
  ON assignment_change_log (target_profile_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_assignment_change_log_actor_created
  ON assignment_change_log (actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_assignment_change_log_action_created
  ON assignment_change_log (action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_assignment_change_log_created
  ON assignment_change_log (created_at DESC);

-- ─── RLS on the audit log ────────────────────────────────────────

ALTER TABLE assignment_change_log ENABLE ROW LEVEL SECURITY;

-- Read: master only. Audit logs include who-did-what across every
-- tenant; only platform-wide admins should see the whole picture.
DROP POLICY IF EXISTS assignment_change_log_master_select ON assignment_change_log;
CREATE POLICY assignment_change_log_master_select ON assignment_change_log
  FOR SELECT
  TO authenticated
  USING (private.auth_is_master());

-- Insert: service role only. The app code writes audit entries
-- via createServerClient (service role), which bypasses RLS. The
-- explicit "no insert from authenticated" stance prevents an
-- authenticated user from forging audit entries.
-- (No INSERT policy = INSERT denied for authenticated; service_role
-- bypasses RLS entirely so no policy is needed for it.)

-- Update / Delete: NEVER. Append-only by design.
-- (No UPDATE/DELETE policies = denied for everyone except service
-- role. We rely on no app code performing UPDATE/DELETE on this
-- table — easier to enforce in code review than to write a hostile
-- DB constraint.)

-- ─── master-count guard trigger ──────────────────────────────────

CREATE OR REPLACE FUNCTION private.guard_at_least_one_master()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  remaining_masters INT;
  scenario TEXT;
BEGIN
  -- Identify the scenario (if any) that would reduce the master count.
  IF TG_OP = 'UPDATE' THEN
    -- Demotion: was master, now isn't.
    IF OLD.role = 'master' AND COALESCE(NEW.role, '') <> 'master' THEN
      scenario := 'demote';
    -- Soft-delete: master row being deactivated.
    ELSIF OLD.role = 'master' AND OLD.active = TRUE AND COALESCE(NEW.active, FALSE) = FALSE THEN
      scenario := 'deactivate';
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    -- Hard-delete (rare).
    IF OLD.role = 'master' AND OLD.active = TRUE THEN
      scenario := 'delete';
    END IF;
  END IF;

  -- No master-count-reducing scenario → allow.
  IF scenario IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Count active masters that would remain after this operation
  -- completes. Excludes the row being mutated/deleted.
  SELECT COUNT(*) INTO remaining_masters
    FROM public.profiles
   WHERE role = 'master'
     AND active = TRUE
     AND id <> OLD.id;

  IF remaining_masters = 0 THEN
    RAISE EXCEPTION
      'Cannot % the last active master. Promote another user to master before changing this one.',
      scenario
      USING ERRCODE = 'check_violation', HINT = 'There must always be at least one active master.';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS guard_at_least_one_master ON profiles;
CREATE TRIGGER guard_at_least_one_master
  BEFORE UPDATE OR DELETE ON profiles
  FOR EACH ROW
  EXECUTE FUNCTION private.guard_at_least_one_master();

COMMENT ON FUNCTION private.guard_at_least_one_master() IS
  'Trigger function on profiles. Rejects any UPDATE that demotes the last active master (role flip OR active=true→false), and any DELETE of the last active master. Defence in depth — application routes also check this before mutating, but the trigger is the unconditional last line of defence. Errors with check_violation so callers can distinguish from auth/permission failures.';

COMMIT;
