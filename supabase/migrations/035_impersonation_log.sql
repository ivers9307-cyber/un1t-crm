-- Master impersonation audit log.
--
-- Every time a master starts impersonating another user (to debug
-- 'why can't they see this' etc.), we log it. Open-ended row —
-- ended_at is NULL while a session is active and is filled in
-- when the master clicks 'Stop impersonating' (or implicitly when
-- they start a new impersonation).
--
-- The cookie carries the target_user_id; this table is the audit
-- trail behind it. Both sides (master + target) can see entries
-- about themselves so there's no covert surveillance.

CREATE TABLE IF NOT EXISTS impersonation_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  master_user_id  uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  target_user_id  uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  started_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz,
  ip              text,
  user_agent      text,
  reason          text,
  CONSTRAINT impersonation_log_no_self CHECK (master_user_id <> target_user_id)
);

CREATE INDEX IF NOT EXISTS impersonation_log_master_idx
  ON impersonation_log(master_user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS impersonation_log_target_idx
  ON impersonation_log(target_user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS impersonation_log_active_idx
  ON impersonation_log(master_user_id) WHERE ended_at IS NULL;

ALTER TABLE impersonation_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS impersonation_log_select ON impersonation_log;
CREATE POLICY impersonation_log_select ON impersonation_log
  FOR SELECT USING (
    private.auth_is_master()
    OR target_user_id = auth.uid()
  );

DROP POLICY IF EXISTS impersonation_log_write ON impersonation_log;
CREATE POLICY impersonation_log_write ON impersonation_log
  FOR ALL
  USING (private.auth_is_master())
  WITH CHECK (private.auth_is_master());

COMMENT ON TABLE impersonation_log IS
  'Audit trail of master impersonation sessions. ended_at NULL = currently active. Cookie un1t_impersonate carries the matching target_user_id.';
