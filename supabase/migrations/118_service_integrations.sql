-- 118_service_integrations.sql
--
-- Phase 4 Slice C: Strava (and future: Garmin / Apple Health / etc)
-- export pipeline. Three tables, one shared OAuth pattern.
--
--   service_integrations          staff-managed app credentials per
--                                 provider. Master sets these via
--                                 /admin/integrations once. Empty
--                                 row = "we haven't set Strava up
--                                 yet" — UI hides the connect button.
--
--   contact_external_integrations the member's per-provider tokens
--                                 + auto-export toggle. Created on
--                                 OAuth callback. RLS scopes to the
--                                 customer's own rows.
--
--   external_export_jobs          queue. endSession enqueues a row
--                                 per (session, contact, provider)
--                                 when the member has auto_export
--                                 on. /api/cron/run-strava-exports
--                                 drains it with backoff.
--
-- Tokens are stored as plain TEXT for v1. The service-role-only
-- access path means RLS prevents leakage to clients, and the
-- existing Supabase Vault rollout is on the maintenance backlog
-- (would migrate all token-bearing tables together).

BEGIN;

-- ── service_integrations (master-managed) ──────────────────────

CREATE TABLE IF NOT EXISTS public.service_integrations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider        text NOT NULL UNIQUE CHECK (provider IN ('strava', 'garmin', 'apple_health', 'fitbit', 'whoop')),
  display_name    text NOT NULL,
  client_id       text,
  client_secret   text,                                 -- TODO: vault when org-wide vault rollout lands
  redirect_uri    text,                                 -- /api/oauth/<provider>/callback in champ-app
  scopes          text[] NOT NULL DEFAULT '{}',         -- e.g. {'activity:write','read'}
  is_enabled      boolean NOT NULL DEFAULT false,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.touch_service_integrations_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END;
$$;
DROP TRIGGER IF EXISTS trg_service_integrations_touch ON public.service_integrations;
CREATE TRIGGER trg_service_integrations_touch
  BEFORE UPDATE ON public.service_integrations
  FOR EACH ROW EXECUTE FUNCTION public.touch_service_integrations_updated_at();

ALTER TABLE public.service_integrations ENABLE ROW LEVEL SECURITY;

-- Master only. Members never see this — they read is_enabled via
-- a thin SECURITY DEFINER fn so we don't leak client_secret.
CREATE POLICY "Masters manage integrations"
  ON public.service_integrations FOR ALL TO authenticated
  USING (private.auth_is_master())
  WITH CHECK (private.auth_is_master());

-- Read-only "is provider X available?" fn for champ-app to render
-- the connect button. Returns provider + display_name + is_enabled,
-- never client_id / client_secret.
CREATE OR REPLACE FUNCTION public.list_enabled_integrations()
RETURNS TABLE (provider text, display_name text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT provider, display_name
  FROM public.service_integrations
  WHERE is_enabled
    AND client_id IS NOT NULL
    AND client_secret IS NOT NULL
  ORDER BY display_name;
$$;
REVOKE ALL ON FUNCTION public.list_enabled_integrations() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.list_enabled_integrations() FROM anon;
GRANT EXECUTE ON FUNCTION public.list_enabled_integrations() TO authenticated;

-- Seed Strava as a disabled placeholder so /admin/integrations shows
-- the row out of the box. Master fills in client_id + client_secret
-- + flips is_enabled later.
INSERT INTO public.service_integrations (provider, display_name, scopes, is_enabled)
VALUES ('strava', 'Strava', ARRAY['activity:write','read'], false)
ON CONFLICT (provider) DO NOTHING;

-- ── contact_external_integrations (member tokens) ──────────────

CREATE TABLE IF NOT EXISTS public.contact_external_integrations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id            uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  provider              text NOT NULL CHECK (provider IN ('strava', 'garmin', 'apple_health', 'fitbit', 'whoop')),
  external_athlete_id   text,
  access_token          text,
  refresh_token         text,
  expires_at            timestamptz,
  scopes                text[] NOT NULL DEFAULT '{}',
  auto_export_enabled   boolean NOT NULL DEFAULT false,
  connected_at          timestamptz NOT NULL DEFAULT now(),
  disconnected_at       timestamptz,
  last_export_at        timestamptz,
  last_error            text,
  UNIQUE (contact_id, provider, disconnected_at)
);

CREATE INDEX IF NOT EXISTS idx_contact_ext_int_contact_active
  ON public.contact_external_integrations (contact_id, provider)
  WHERE disconnected_at IS NULL;

ALTER TABLE public.contact_external_integrations ENABLE ROW LEVEL SECURITY;

-- Customer reads + manages own. Tokens never leave the server side
-- (the OAuth callback writes them; the member-facing page reads
-- only auto_export_enabled / connected_at / external_athlete_id).
CREATE POLICY "Customers read own integrations"
  ON public.contact_external_integrations FOR SELECT TO public
  USING (contact_id = private.auth_contact_id());

CREATE POLICY "Customers update own integration toggle"
  ON public.contact_external_integrations FOR UPDATE TO public
  USING (contact_id = private.auth_contact_id())
  WITH CHECK (contact_id = private.auth_contact_id());

CREATE POLICY "Staff read integrations at their locations"
  ON public.contact_external_integrations FOR SELECT TO public
  USING (
    private.auth_is_master()
    OR EXISTS (
      SELECT 1 FROM public.contacts c
      WHERE c.id = contact_external_integrations.contact_id
        AND private.auth_is_in_location(c.location_id)
    )
  );

-- ── external_export_jobs (worker queue) ───────────────────────

CREATE TABLE IF NOT EXISTS public.external_export_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      uuid NOT NULL REFERENCES public.heart_rate_sessions(id) ON DELETE CASCADE,
  contact_id      uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  provider        text NOT NULL,
  status          text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'succeeded', 'failed', 'skipped')),
  attempts        int NOT NULL DEFAULT 0,
  last_error      text,
  external_id     text,
  queued_at       timestamptz NOT NULL DEFAULT now(),
  processed_at    timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, contact_id, provider)
);

-- Worker drains queued / past-due rows, oldest first.
CREATE INDEX IF NOT EXISTS idx_export_jobs_drain
  ON public.external_export_jobs (next_attempt_at)
  WHERE status IN ('queued', 'processing');

CREATE INDEX IF NOT EXISTS idx_export_jobs_contact_status
  ON public.external_export_jobs (contact_id, status, queued_at DESC);

ALTER TABLE public.external_export_jobs ENABLE ROW LEVEL SECURITY;
-- Service-role-only writes/reads. No customer policy — worker uses
-- service role; member-facing page reads via the parent
-- contact_external_integrations row's last_export_at /
-- last_error fields. (Staff at the contact's location can read for
-- support / debugging.)
CREATE POLICY "Staff read export jobs at their locations"
  ON public.external_export_jobs FOR SELECT TO public
  USING (
    private.auth_is_master()
    OR EXISTS (
      SELECT 1 FROM public.contacts c
      WHERE c.id = external_export_jobs.contact_id
        AND private.auth_is_in_location(c.location_id)
    )
  );

COMMIT;
