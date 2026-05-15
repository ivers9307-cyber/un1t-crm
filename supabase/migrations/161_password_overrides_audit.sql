-- ============================================================
-- 161: AUTH.1 — password override audit log
-- ============================================================
--
-- WHY THIS MIGRATION EXISTS
-- ─────────────────────────
-- Operator request: master/owner needs the ability to manually set
-- a user's password from the CRM (both staff profiles and member
-- contacts). Done via Supabase auth.admin.updateUserById; this
-- table is the audit trail so we have a record of every override:
-- who did it, against whom, when, why.
--
-- The new password itself is NEVER stored — only that an override
-- happened. The /api/admin/password-override endpoint returns the
-- new value to the admin's browser ONCE so they can pass it to
-- the user, then it's gone.

CREATE TABLE IF NOT EXISTS password_overrides_audit (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_user_id     UUID NOT NULL,     -- auth.users.id of the affected account
  target_type        TEXT NOT NULL CHECK (target_type IN ('staff','member')),
  target_profile_id  UUID REFERENCES profiles(id) ON DELETE SET NULL,
  target_contact_id  UUID REFERENCES contacts(id) ON DELETE SET NULL,
  performed_by       UUID NOT NULL REFERENCES profiles(id) ON DELETE SET NULL,
  performed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  location_id        UUID REFERENCES locations(id) ON DELETE SET NULL,
  reason             TEXT,
  ip_address         TEXT
);

COMMENT ON TABLE password_overrides_audit IS
  'AUTH.1 — record of every admin-initiated password override. Never stores the password itself.';

CREATE INDEX IF NOT EXISTS idx_password_overrides_target ON password_overrides_audit (target_user_id, performed_at DESC);
CREATE INDEX IF NOT EXISTS idx_password_overrides_by     ON password_overrides_audit (performed_by, performed_at DESC);

ALTER TABLE password_overrides_audit ENABLE ROW LEVEL SECURITY;

-- master/owner can read the audit log site-wide; everyone else
-- can't read it. Writes happen via service_role only (the API
-- route inserts after the auth.admin update succeeds).
CREATE POLICY password_overrides_audit_master_read
  ON password_overrides_audit
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = (SELECT auth.uid())
        AND p.role IN ('master','owner')
    )
  );
