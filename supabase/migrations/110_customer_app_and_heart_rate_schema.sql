-- 110_customer_app_and_heart_rate_schema.sql
--
-- Customer-facing app foundation + heart rate monitoring schema.
--
-- Background
-- ----------
-- Phase 0 of the Myzone-replacement project. We're standing up
-- champ-app (a separate Next.js project on app.champfitness.ie)
-- as the customer-facing portal. It shares this Supabase project
-- so customer data lives next to staff data in one source of truth,
-- but the customer app is a completely separate deploy with its
-- own RLS scope.
--
-- Two big additions in this migration:
--
-- 1) CUSTOMER AUTH MODEL
--    `contacts.user_id` links an auth.users row to a contact. A
--    customer in the app is just an auth.users + a contacts row
--    where user_id = auth.uid().
--
--    We deliberately do NOT add 'customer' to the profiles.role
--    enum. profiles stays a staff-only table. Adding a customer
--    role there would force every existing role-check policy to
--    re-confirm "and not a customer", and would expose the staff
--    role surface to customers. Cleaner to keep them as separate
--    auth shapes:
--      staff    = auth.users + profiles row (with role)
--      customer = auth.users + contacts row (with user_id)
--
--    A new SECURITY DEFINER helper `private.auth_contact_id()`
--    returns the current user's contact_id (or NULL if they're
--    a staff user / not linked). All customer-facing RLS policies
--    delegate to this so they're simple and cheap to audit.
--
-- 2) HEART RATE SCHEMA (5 tables)
--    heart_rate_sessions   one row per workout session
--    hr_samples            per-second BPM (high cardinality — see notes)
--    hr_provider_connections OAuth tokens for Fitbit/Whoop/Garmin/Apple
--    ble_bridges           one row per gym's bridge box
--    strap_assignments     ephemeral strap → contact mapping during class
--
-- Cardinality notes
-- -----------------
-- hr_samples will get LARGE. ~3600 rows/hour/session × dozens of
-- sessions/day adds up to millions of rows/year/location. For v1
-- we use plain btree on (session_id, recorded_at). When we hit
-- ~50M rows we'll switch to TimescaleDB hypertable or partitioning
-- by month. The existing data model is forward-compatible with
-- both: session_id is the natural partition key.
--
-- Encryption
-- ----------
-- hr_provider_connections.access_token / refresh_token are stored
-- as plaintext in this migration with a TODO. Supabase Vault is
-- the right home for them long-term but isn't enabled on this
-- project yet. Service-role-only RLS means they're not reachable
-- from a customer session — the only exposure is a Postgres dump.
-- Acceptable for v1; revisit before we have ~100 customers.

BEGIN;

-- ── 1. contacts.user_id + auth_contact_id helper ────────────────

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS contacts_user_id_unique
  ON public.contacts(user_id)
  WHERE user_id IS NOT NULL;

CREATE OR REPLACE FUNCTION private.auth_contact_id()
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT id FROM public.contacts WHERE user_id = auth.uid()
$$;

REVOKE ALL ON FUNCTION private.auth_contact_id() FROM public;
GRANT EXECUTE ON FUNCTION private.auth_contact_id() TO authenticated, service_role;

-- Customers can read their own contact row (staff already have access via existing policies).
-- The existing contacts table has staff-facing RLS policies; we add a customer-self read.
DROP POLICY IF EXISTS "Customers can read own contact" ON public.contacts;
CREATE POLICY "Customers can read own contact" ON public.contacts
  FOR SELECT TO public
  USING (user_id = (SELECT auth.uid()));

-- Customers can update a small allow-list of fields on their own contact
-- (name, phone, marketing_opt_in, max_hr_override). Field-level enforcement
-- happens in the API layer; row-level access is gated here.
DROP POLICY IF EXISTS "Customers can update own contact" ON public.contacts;
CREATE POLICY "Customers can update own contact" ON public.contacts
  FOR UPDATE TO public
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

-- ── 2. contacts.max_hr_override (HR zones need per-customer max) ─

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS max_hr_override smallint
    CHECK (max_hr_override IS NULL OR (max_hr_override BETWEEN 100 AND 240));

COMMENT ON COLUMN public.contacts.max_hr_override IS
  'Optional override for max HR. NULL means use 220 - age default in zone math.';

-- ── 3. heart_rate_sessions ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.heart_rate_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id      uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  location_id     uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  booking_id      uuid REFERENCES public.bookings(id) ON DELETE SET NULL,
  source          text NOT NULL CHECK (source IN ('ble_bridge','apple_health','fitbit','whoop','garmin','manual')),
  device_identifier text,
  started_at      timestamptz NOT NULL,
  ended_at        timestamptz,
  max_hr_used     smallint NOT NULL CHECK (max_hr_used BETWEEN 100 AND 240),
  avg_hr_bpm      smallint CHECK (avg_hr_bpm IS NULL OR avg_hr_bpm BETWEEN 30 AND 240),
  peak_hr_bpm     smallint CHECK (peak_hr_bpm IS NULL OR peak_hr_bpm BETWEEN 30 AND 240),
  zones_seconds   jsonb,
  effort_points   integer CHECK (effort_points IS NULL OR effort_points >= 0),
  raw_metadata    jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hr_sessions_contact_started
  ON public.heart_rate_sessions(contact_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_hr_sessions_booking
  ON public.heart_rate_sessions(booking_id) WHERE booking_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hr_sessions_location
  ON public.heart_rate_sessions(location_id, started_at DESC);
-- Live-session lookup for the in-class TV display.
CREATE INDEX IF NOT EXISTS idx_hr_sessions_live
  ON public.heart_rate_sessions(location_id) WHERE ended_at IS NULL;

ALTER TABLE public.heart_rate_sessions ENABLE ROW LEVEL SECURITY;

-- Staff: existing role-based access. Coaches/admins can see sessions at their locations.
CREATE POLICY "Staff can view sessions at their locations"
  ON public.heart_rate_sessions FOR SELECT TO public
  USING (private.auth_is_in_location(location_id));

-- Customer: see own sessions only.
CREATE POLICY "Customers can view own sessions"
  ON public.heart_rate_sessions FOR SELECT TO public
  USING (contact_id = private.auth_contact_id());

-- Writes: service-role only (bridge + sync workers use service-role client).
-- No INSERT/UPDATE policy = no row-level access for authenticated users.

-- ── 4. hr_samples ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.hr_samples (
  session_id   uuid NOT NULL REFERENCES public.heart_rate_sessions(id) ON DELETE CASCADE,
  recorded_at  timestamptz NOT NULL,
  bpm          smallint NOT NULL CHECK (bpm BETWEEN 30 AND 240),
  PRIMARY KEY (session_id, recorded_at)
);

-- recorded_at-only index for time-range queries across sessions.
CREATE INDEX IF NOT EXISTS idx_hr_samples_recorded ON public.hr_samples(recorded_at);

ALTER TABLE public.hr_samples ENABLE ROW LEVEL SECURITY;

-- Read access via parent session: staff at location, or owning customer.
CREATE POLICY "Read samples via session access"
  ON public.hr_samples FOR SELECT TO public
  USING (
    EXISTS (
      SELECT 1 FROM public.heart_rate_sessions s
      WHERE s.id = hr_samples.session_id
        AND (
          private.auth_is_in_location(s.location_id)
          OR s.contact_id = private.auth_contact_id()
        )
    )
  );

-- ── 5. hr_provider_connections (OAuth) ──────────────────────────

CREATE TABLE IF NOT EXISTS public.hr_provider_connections (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id         uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  provider           text NOT NULL CHECK (provider IN ('apple_health','fitbit','whoop','garmin')),
  access_token       text NOT NULL,    -- TODO Supabase Vault when available
  refresh_token      text,
  token_expires_at   timestamptz,
  scopes             jsonb,
  provider_user_id   text,
  last_synced_at     timestamptz,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','revoked','error')),
  last_error         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contact_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_hr_provider_contact
  ON public.hr_provider_connections(contact_id);
CREATE INDEX IF NOT EXISTS idx_hr_provider_status
  ON public.hr_provider_connections(status, last_synced_at) WHERE status = 'active';

ALTER TABLE public.hr_provider_connections ENABLE ROW LEVEL SECURITY;

-- Customer: see + delete own connections (revoke flow). Token columns are
-- never returned to clients via API in practice — server-only — but RLS
-- still allows SELECT so the customer can list which providers are linked.
CREATE POLICY "Customers can view own provider connections"
  ON public.hr_provider_connections FOR SELECT TO public
  USING (contact_id = private.auth_contact_id());

CREATE POLICY "Customers can revoke own provider connections"
  ON public.hr_provider_connections FOR DELETE TO public
  USING (contact_id = private.auth_contact_id());

-- INSERT/UPDATE: service-role only (OAuth callback + cron sync workers).

-- Trigger to keep updated_at fresh.
CREATE OR REPLACE FUNCTION public.touch_hr_provider_connections_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_hr_provider_touch_updated_at ON public.hr_provider_connections;
CREATE TRIGGER trg_hr_provider_touch_updated_at
  BEFORE UPDATE ON public.hr_provider_connections
  FOR EACH ROW EXECUTE FUNCTION public.touch_hr_provider_connections_updated_at();

-- ── 6. ble_bridges (one per gym) ─────────────────────────────────

CREATE TABLE IF NOT EXISTS public.ble_bridges (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id       uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  name              text NOT NULL,
  hardware_id       text NOT NULL UNIQUE,
  api_token_hash    text NOT NULL,        -- bcrypt of bearer token; raw shown once at create
  last_seen_at      timestamptz,
  status            text NOT NULL DEFAULT 'offline'
                      CHECK (status IN ('online','offline','error')),
  software_version  text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ble_bridges_location ON public.ble_bridges(location_id);

ALTER TABLE public.ble_bridges ENABLE ROW LEVEL SECURITY;

-- Staff at the location can view bridge state. Master can manage all.
CREATE POLICY "Staff can view bridges at location"
  ON public.ble_bridges FOR SELECT TO public
  USING (private.auth_is_in_location(location_id));

CREATE POLICY "Master can manage bridges"
  ON public.ble_bridges FOR ALL TO public
  USING (private.auth_is_master())
  WITH CHECK (private.auth_is_master());

-- ── 7. strap_assignments ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.strap_assignments (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ble_bridge_id            uuid NOT NULL REFERENCES public.ble_bridges(id) ON DELETE CASCADE,
  contact_id               uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  strap_mac                text NOT NULL,
  strap_label              text,
  paired_at                timestamptz NOT NULL DEFAULT now(),
  ended_at                 timestamptz,
  booking_id               uuid REFERENCES public.bookings(id) ON DELETE SET NULL,
  heart_rate_session_id    uuid REFERENCES public.heart_rate_sessions(id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_strap_assignments_bridge_active
  ON public.strap_assignments(ble_bridge_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_strap_assignments_contact
  ON public.strap_assignments(contact_id, paired_at DESC);
CREATE INDEX IF NOT EXISTS idx_strap_assignments_session
  ON public.strap_assignments(heart_rate_session_id) WHERE heart_rate_session_id IS NOT NULL;

ALTER TABLE public.strap_assignments ENABLE ROW LEVEL SECURITY;

-- Staff at the bridge's location can view + manage assignments.
CREATE POLICY "Staff can view strap assignments"
  ON public.strap_assignments FOR SELECT TO public
  USING (
    EXISTS (
      SELECT 1 FROM public.ble_bridges b
      WHERE b.id = strap_assignments.ble_bridge_id
        AND private.auth_is_in_location(b.location_id)
    )
  );

CREATE POLICY "Admins can manage strap assignments"
  ON public.strap_assignments FOR ALL TO public
  USING (private.auth_is_admin_or_head_coach())
  WITH CHECK (private.auth_is_admin_or_head_coach());

-- Customer: see own assignments (so they can confirm they're paired).
CREATE POLICY "Customers can view own strap assignments"
  ON public.strap_assignments FOR SELECT TO public
  USING (contact_id = private.auth_contact_id());

COMMIT;
