-- ============================================================
-- 431: support_sessions — Repset Phase 3 tenant support access
-- ============================================================
--
-- SUPPORT-ACCESS. A MASTER opens a "support session" to view into a
-- tenant ORGANIZATION from the Platform Console and help them, in one
-- of two modes:
--
--   • read_only      — the master sees the tenant's account home /
--                      studios but EVERY state-changing request is
--                      rejected at the central chokepoint (src/proxy.js).
--   • act_on_behalf  — writes allowed, but SCOPED to the target org
--                      via the existing impersonation mechanism (the
--                      master impersonates an owner of the org, so all
--                      the existing IDOR/location guards keep them
--                      inside that tenant).
--
-- This table is the AUDIT TRAIL. Mirrors impersonation_log (mig 035)
-- and host_impersonation_log (mig 389): one open row per master at a
-- time; started on open, ended_at stamped on exit or by the
-- close-stale-impersonations reaper (extended in this phase to also
-- close support sessions). The signed `un1t_support` cookie carries the
-- matching (sid, org, mode); this table is the durable record behind it.
--
-- RLS shape follows mig 413/420 (plans/wallets): ONE permissive
-- master-only SELECT for `authenticated`, plus a RESTRICTIVE deny-all
-- for authenticated/anon writes. All writes go through the service-role
-- client (createServerClient bypasses RLS); the API routes enforce
-- profileRole === 'master' themselves. private.auth_is_master()
-- resolves the caller itself, so no (SELECT auth.uid()) wrap is needed.

BEGIN;

CREATE TABLE IF NOT EXISTS public.support_sessions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  master_user_id         uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  target_organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- The owner profile the master is impersonating for this session, when
  -- one exists (act_on_behalf ALWAYS impersonates; read_only impersonates
  -- when an owner is available for the tenant-eye view). NULL = scope-only
  -- (org has no owner/admin profile; the master stays themselves but the
  -- portfolio is scoped to the org). SET NULL on profile delete so the
  -- audit row survives.
  impersonated_user_id   uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  mode                   text NOT NULL CHECK (mode IN ('read_only', 'act_on_behalf')),
  reason                 text,
  ip                     text,
  user_agent             text,
  started_at             timestamptz NOT NULL DEFAULT now(),
  ended_at               timestamptz,
  -- true when ended_at was stamped by the close-stale reaper at the
  -- session max-age (exact end unknown, upper bound) rather than by an
  -- explicit Exit / re-open. Mirrors impersonation_log.auto_closed.
  auto_closed            boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS support_sessions_master_idx
  ON public.support_sessions(master_user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS support_sessions_org_idx
  ON public.support_sessions(target_organization_id, started_at DESC);
-- Partial index for the "one open row per master" close + the reaper scan.
CREATE INDEX IF NOT EXISTS support_sessions_open_idx
  ON public.support_sessions(master_user_id) WHERE ended_at IS NULL;

ALTER TABLE public.support_sessions ENABLE ROW LEVEL SECURITY;

-- One permissive SELECT policy (mig 320 rule) — master-only read.
DROP POLICY IF EXISTS support_sessions_select ON public.support_sessions;
CREATE POLICY support_sessions_select ON public.support_sessions
  FOR SELECT TO authenticated
  USING (private.auth_is_master());

-- Restrictive deny-all for writes (mig 413/420 pattern). Service-role
-- bypasses RLS entirely, so the app-layer master gate is the real
-- control; this closes the door for any authenticated/anon caller.
DROP POLICY IF EXISTS support_sessions_deny_writes ON public.support_sessions;
CREATE POLICY support_sessions_deny_writes ON public.support_sessions
  AS RESTRICTIVE FOR ALL TO authenticated, anon
  USING (false) WITH CHECK (false);

COMMENT ON TABLE public.support_sessions IS
  'Audit trail of master tenant-support sessions (Repset Phase 3). ended_at NULL = currently active. mode read_only = writes blocked at src/proxy.js; act_on_behalf = writes allowed, scoped to target_organization_id via impersonation. Signed un1t_support cookie carries the matching (sid, org, mode). Master-only SELECT; service-role writes.';

COMMIT;
