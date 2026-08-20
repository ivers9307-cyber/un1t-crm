-- SONOS.6 — studio music moves off the Homey Pro onto the Sonos Control API.
--
-- Two tables:
--   sonos_connections — one OAuth grant per location. location_id carries a
--     NOT NULL UNIQUE constraint, not the PRIMARY KEY — the same b-tree
--     guarantee with no NULL loophole, but row identity runs on a separate
--     surrogate id, matching xero_connections (mig 029): src/lib/sonos/
--     client.js reads a row by location_id and later writes it back by id.
--     household_id is UNIQUE too, and that is the constraint that actually
--     mirrors the Xero tenants[0] bug (mig 554): three locations resolved
--     to one tenant and posted 101 bills / ~EUR 99k into the wrong legal
--     entity before anyone noticed. location_id UNIQUE alone only stops
--     one location acquiring two connection rows; it says nothing about
--     two locations sharing one household — household_id UNIQUE is what
--     forbids that outright.
--   sonos_schedules — the music windows. Several rows per location are
--     allowed so a second zone (reception vs floor) needs no migration.
--
-- Writes are service-role throughout (OAuth callback, cron, staff routes
-- that authorise in app code), so there are no write policies — only
-- per-command denials. Deliberately NOT a RESTRICTIVE ... FOR ALL, which
-- would fold away the SELECT policy too and silently return an empty set
-- (the mig 483/485 class of bug).

CREATE TABLE public.sonos_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL UNIQUE REFERENCES public.locations(id) ON DELETE CASCADE,
  household_id text NOT NULL,
  refresh_token text NOT NULL,
  access_token text,
  access_token_expires_at timestamptz,
  linked_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN public.sonos_connections.location_id IS
  'SONOS.6 — UNIQUE: one location = one Sonos household. The callback stores the household the operator picked, never households[0].';
COMMENT ON COLUMN public.sonos_connections.refresh_token IS
  'Sonos does not rotate refresh tokens — the same value is returned on every refresh, so this column is written once at link time.';

-- household_id UNIQUE — the direction that actually mirrors the Xero
-- tenants[0] bug (see header): a household cannot straddle two locations
-- either. Two multi-site gyms each run their own household on their own
-- network, so sharing is always a misconfiguration, never a legitimate
-- setup. Named CONSTRAINT (mig 554's style) so a violation reports
-- something a human can read, rather than a bare unique index.
ALTER TABLE public.sonos_connections
  ADD CONSTRAINT sonos_connections_household_id_unique UNIQUE (household_id);

COMMENT ON CONSTRAINT sonos_connections_household_id_unique ON public.sonos_connections IS
  'SONOS.6 — one Sonos household serves exactly one location, never shared. Two locations on one household would have each other''s music schedules driving their speakers. Correct a wrong binding by disconnecting the other location first, then re-linking the correct one.';

CREATE TABLE public.sonos_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT 'Studio music',
  player_ids text[] NOT NULL DEFAULT '{}',
  enabled boolean NOT NULL DEFAULT false,
  windows jsonb NOT NULL DEFAULT '[]'::jsonb,
  override jsonb,
  last_applied jsonb,
  last_state jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sonos_schedules_location_enabled_idx
  ON public.sonos_schedules (location_id) WHERE enabled;

COMMENT ON COLUMN public.sonos_schedules.player_ids IS
  'Permanent Sonos player ids (RINCON_*, MAC-derived). NEVER group ids — Sonos documents those as ephemeral, so a schedule keyed on one breaks the first time someone regroups a speaker in the app.';
COMMENT ON COLUMN public.sonos_schedules.windows IS
  '[{days:[1..7], on:"06:00", off:"21:30", volume:0-100, favorite_id:"..."}]. Consumed by resolveServeWindows in src/lib/schedule/desired-state.js as fixed_windows.';
COMMENT ON COLUMN public.sonos_schedules.last_applied IS
  '{window_on_at, action:"open"|"close", at}. loadFavorite is NOT idempotent — re-issuing it restarts the playlist — so windows are applied exactly once rather than continuously reconciled.';
COMMENT ON COLUMN public.sonos_schedules.override IS
  '{state:"off", until} — suppression only. While live the cron no-ops entirely. There is deliberately no {state:"on"}: it would have to invent a volume and favourite, and the honest source for both is a window.';

ALTER TABLE public.sonos_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sonos_schedules ENABLE ROW LEVEL SECURITY;

-- Connections hold a refresh token, so reads are master/owner only and the
-- token column is never selected by client code (routes use service-role).
CREATE POLICY sonos_connections_select ON public.sonos_connections
  FOR SELECT TO authenticated
  USING (
    private.auth_is_master()
    OR private.auth_is_owner_at(sonos_connections.location_id)
  );

CREATE POLICY sonos_connections_deny_insert ON public.sonos_connections
  AS RESTRICTIVE FOR INSERT TO authenticated, anon WITH CHECK (false);
CREATE POLICY sonos_connections_deny_update ON public.sonos_connections
  AS RESTRICTIVE FOR UPDATE TO authenticated, anon USING (false) WITH CHECK (false);
CREATE POLICY sonos_connections_deny_delete ON public.sonos_connections
  AS RESTRICTIVE FOR DELETE TO authenticated, anon USING (false);

-- Schedules carry no secrets: any staff member attached to the location
-- may read them.
CREATE POLICY sonos_schedules_select ON public.sonos_schedules
  FOR SELECT TO authenticated
  USING (private.auth_is_in_location(sonos_schedules.location_id));

CREATE POLICY sonos_schedules_deny_insert ON public.sonos_schedules
  AS RESTRICTIVE FOR INSERT TO authenticated, anon WITH CHECK (false);
CREATE POLICY sonos_schedules_deny_update ON public.sonos_schedules
  AS RESTRICTIVE FOR UPDATE TO authenticated, anon USING (false) WITH CHECK (false);
CREATE POLICY sonos_schedules_deny_delete ON public.sonos_schedules
  AS RESTRICTIVE FOR DELETE TO authenticated, anon USING (false);
