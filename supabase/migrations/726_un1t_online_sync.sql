-- 726 — UN1TSYNC.1: mirror Hatch Street's un1t.online platform into the CRM
-- (plan .superpowers/sdd/2026-10-16-un1t-online-hatch-sync; spec
-- docs/superpowers/specs/2026-09-01-un1t-online-hatch-integration-design.md).
--
-- WHY. Hatch Street sells memberships and runs classes on un1t.online, not
-- Glofox (locations.membership_source = 'none', mig 717; memberships were
-- hand-imported from a client export, mig 722). A read-only sync pulls the
-- platform's clients, products, subscriptions, transactions, invoices,
-- events and bookings into the CRM so the contact page, event pricing and
-- the member gates see Hatch's real state.
--
-- WHAT.
--   (1) contacts.un1t_user_id / un1t_synced_at: the link from a CRM contact
--       to its un1t.online user. Unique per (organisation, id) (partial: most
--       contacts have none; a person is one contact per organisation). Sync bookkeeping only, not an audience field.
--   (2) Eight service-role-only tables: un1t_clients (NO raw: client rows
--       are PII, only derived counters are kept), un1t_products,
--       un1t_subscriptions, un1t_transactions, un1t_invoices, un1t_events,
--       un1t_bookings (raw jsonb kept, minus the fields the plan forbids
--       storing) and un1t_sync_runs (one row per cron run).
--       Each is keyed (location_id, un1t_id): a sync is an upsert and never
--       deletes a row that is absent from a pull.
--   (3) Three CHECKs widened by one value each: channel_connections.platform
--       gains 'un1t_online' (the API token lives in the connection registry,
--       like Glofox's), locations.membership_source gains 'un1t_online'
--       ('un1t' stays reserved for built-in memberships), and
--       contact_memberships.source gains 'un1t_online_api' beside the
--       operator export's 'un1t_online_export'.
--
-- GRANTS. Every new table: RLS on, NO policy, REVOKE ALL from anon and
-- authenticated (the mig 677 default, stated explicitly), service_role only.
-- No client reads these tables; staff see the data through /api routes.
--
-- LOCKS. One transaction with a 5s lock_timeout: swapping the locations
-- CHECK takes ACCESS EXCLUSIVE on locations, which every getCurrentUser
-- joins (as mig 717 notes); ADD COLUMN on contacts is brief for the same
-- reason. The self-check at the end reads the catalog, never this file's
-- text, and aborts the whole file.
--
-- Not in this file: the cron_heartbeats row for the sync cron; it goes in
-- the migration that ships the cron route, per CLAUDE.md "New cron".

BEGIN;
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- (1) contacts link columns
-- ---------------------------------------------------------------------------
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS un1t_user_id   text,
  ADD COLUMN IF NOT EXISTS un1t_synced_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS contacts_un1t_user_id_unique
  ON public.contacts (organization_id, un1t_user_id)
  WHERE un1t_user_id IS NOT NULL;

COMMENT ON COLUMN public.contacts.un1t_user_id IS
  'UN1TSYNC.1 (mig 726): the contact''s user id on un1t.online (Hatch Street). Written only by the un1t.online sync. Unique per organisation when set.';
COMMENT ON COLUMN public.contacts.un1t_synced_at IS
  'UN1TSYNC.1 (mig 726): when the un1t.online sync last matched this contact.';

-- ---------------------------------------------------------------------------
-- (2) The mirror tables
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.un1t_clients (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id           uuid        NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  un1t_user_id          text        NOT NULL,
  contact_id            uuid        REFERENCES public.contacts(id) ON DELETE SET NULL,
  status                text,
  credit_balance        integer,
  credit_unlimited      boolean,
  last_attended_at      timestamptz,
  bookings_30d_attended integer,
  bookings_30d_no_show  integer,
  ltv_cents             integer,
  remote_created_at     timestamptz,
  remote_updated_at     timestamptz,
  synced_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_id, un1t_user_id)
);
CREATE INDEX IF NOT EXISTS un1t_clients_location_contact
  ON public.un1t_clients (location_id, contact_id);

CREATE TABLE IF NOT EXISTS public.un1t_products (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id             uuid        NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  un1t_id                 text        NOT NULL,
  title                   text,
  type                    text,
  status                  text,
  visibility              text,
  price_cents             integer,
  currency                text,
  billing_interval        text,
  billing_interval_count  integer,
  credits_per_period      integer,
  raw                     jsonb,
  synced_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_id, un1t_id)
);

CREATE TABLE IF NOT EXISTS public.un1t_subscriptions (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id             uuid        NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  un1t_id                 text        NOT NULL,
  un1t_user_id            text,
  contact_id              uuid        REFERENCES public.contacts(id) ON DELETE SET NULL,
  product_id              text,
  product_title           text,
  status                  text,
  price_cents             integer,
  currency                text,
  billing_interval        text,
  billing_interval_count  integer,
  credits_per_period      integer,
  current_period_start    timestamptz,
  current_period_end      timestamptz,
  cancel_at_period_end    boolean,
  trial_end               timestamptz,
  paused_at               timestamptz,
  paused_until            timestamptz,
  past_due_at             timestamptz,
  remote_created_at       timestamptz,
  remote_updated_at       timestamptz,
  raw                     jsonb,
  synced_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_id, un1t_id)
);
CREATE INDEX IF NOT EXISTS un1t_subscriptions_location_contact
  ON public.un1t_subscriptions (location_id, contact_id);

CREATE TABLE IF NOT EXISTS public.un1t_transactions (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id       uuid        NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  un1t_id           text        NOT NULL,
  un1t_user_id      text,
  contact_id        uuid        REFERENCES public.contacts(id) ON DELETE SET NULL,
  product_id        text,
  product_title     text,
  invoice_id        text,
  type              text,
  product_type      text,
  amount_cents      integer,
  currency          text,
  refunded          boolean,
  refund_status     text,
  remote_created_at timestamptz,
  raw               jsonb,
  synced_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_id, un1t_id)
);
CREATE INDEX IF NOT EXISTS un1t_transactions_location_contact
  ON public.un1t_transactions (location_id, contact_id);

CREATE TABLE IF NOT EXISTS public.un1t_invoices (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id       uuid        NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  un1t_id           text        NOT NULL,
  un1t_user_id      text,
  contact_id        uuid        REFERENCES public.contacts(id) ON DELETE SET NULL,
  subscription_id   text,
  status            text,
  amount_cents      integer,
  currency          text,
  remote_created_at timestamptz,
  raw               jsonb,
  synced_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_id, un1t_id)
);
CREATE INDEX IF NOT EXISTS un1t_invoices_location_contact
  ON public.un1t_invoices (location_id, contact_id);

CREATE TABLE IF NOT EXISTS public.un1t_events (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id     uuid        NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  un1t_id         text        NOT NULL,
  title           text,
  status          text,
  access_mode     text,
  is_free         boolean,
  starts_at       timestamptz,
  ends_at         timestamptz,
  capacity        integer,
  bookings_count  integer,
  series_id       text,
  raw             jsonb,
  synced_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_id, un1t_id)
);

CREATE TABLE IF NOT EXISTS public.un1t_bookings (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id          uuid        NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  un1t_id              text        NOT NULL,
  un1t_user_id         text,
  contact_id           uuid        REFERENCES public.contacts(id) ON DELETE SET NULL,
  event_id             text,
  status               text,
  source               text,
  credit_charged       boolean,
  has_guest            boolean,
  external_member_ref  text,
  external_booking_ref text,
  remote_created_at    timestamptz,
  remote_updated_at    timestamptz,
  raw                  jsonb,
  synced_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_id, un1t_id)
);
CREATE INDEX IF NOT EXISTS un1t_bookings_location_contact
  ON public.un1t_bookings (location_id, contact_id);

CREATE TABLE IF NOT EXISTS public.un1t_sync_runs (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id  uuid        NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  duration_ms  integer,
  status       text        NOT NULL CHECK (status IN ('running', 'ok', 'error')),
  counts       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  first_error  text
);
CREATE INDEX IF NOT EXISTS un1t_sync_runs_location_started
  ON public.un1t_sync_runs (location_id, started_at DESC);

COMMENT ON TABLE public.un1t_clients IS
  'UN1TSYNC.1 (mig 726): un1t.online client rows for a studio, derived counters only (no raw payload: client rows are PII). Service role only; the sync upserts and never deletes.';
COMMENT ON TABLE public.un1t_products IS
  'UN1TSYNC.1 (mig 726): un1t.online products (membership plans, packs). Service role only; the sync upserts and never deletes.';
COMMENT ON TABLE public.un1t_subscriptions IS
  'UN1TSYNC.1 (mig 726): un1t.online subscriptions. One drives a contact_memberships row (source un1t_online_api). Service role only; the sync upserts and never deletes.';
COMMENT ON TABLE public.un1t_transactions IS
  'UN1TSYNC.1 (mig 726): un1t.online payments and refunds, money in integer cents. Service role only; the sync upserts and never deletes.';
COMMENT ON TABLE public.un1t_invoices IS
  'UN1TSYNC.1 (mig 726): un1t.online invoices, without the invoice URL. Service role only; the sync upserts and never deletes.';
COMMENT ON TABLE public.un1t_events IS
  'UN1TSYNC.1 (mig 726): un1t.online classes and events. NOT written to class_occurrences (a follow-up plan audits that table''s readers first). Service role only; the sync upserts and never deletes.';
COMMENT ON TABLE public.un1t_bookings IS
  'UN1TSYNC.1 (mig 726): un1t.online bookings, without guest details. NOT written to class_bookings (follow-up plan). Service role only; the sync upserts and never deletes.';
COMMENT ON TABLE public.un1t_sync_runs IS
  'UN1TSYNC.1 (mig 726): one row per un1t.online sync run per studio: status, per-list counts, first error. Service role only.';

-- Closed to every client session; the sync runs on the service role.
ALTER TABLE public.un1t_clients       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.un1t_products      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.un1t_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.un1t_transactions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.un1t_invoices      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.un1t_events        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.un1t_bookings      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.un1t_sync_runs     ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.un1t_clients       FROM anon, authenticated;
REVOKE ALL ON public.un1t_products      FROM anon, authenticated;
REVOKE ALL ON public.un1t_subscriptions FROM anon, authenticated;
REVOKE ALL ON public.un1t_transactions  FROM anon, authenticated;
REVOKE ALL ON public.un1t_invoices      FROM anon, authenticated;
REVOKE ALL ON public.un1t_events        FROM anon, authenticated;
REVOKE ALL ON public.un1t_bookings      FROM anon, authenticated;
REVOKE ALL ON public.un1t_sync_runs     FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.un1t_clients       TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.un1t_products      TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.un1t_subscriptions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.un1t_transactions  TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.un1t_invoices      TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.un1t_events        TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.un1t_bookings      TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.un1t_sync_runs     TO service_role;

-- ---------------------------------------------------------------------------
-- (3) Widen three CHECKs by one value each
-- ---------------------------------------------------------------------------
-- channel_connections.platform: the mig 418 list plus 'un1t_online'.
ALTER TABLE public.channel_connections
  DROP CONSTRAINT IF EXISTS channel_connections_platform_check;
ALTER TABLE public.channel_connections
  ADD CONSTRAINT channel_connections_platform_check
  CHECK (platform = ANY (ARRAY[
    'instagram'::text,
    'messenger'::text,
    'glofox'::text,
    'unifi'::text,
    'sensibo'::text,
    'thinq'::text,
    'twilio_sender'::text,
    'bca'::text,
    'postmark_domain'::text,
    'un1t_online'::text
  ]));

-- locations.membership_source: 'un1t_online' is the API-synced source;
-- 'un1t' stays reserved for built-in memberships.
ALTER TABLE public.locations
  DROP CONSTRAINT IF EXISTS locations_membership_source_check;
ALTER TABLE public.locations
  ADD CONSTRAINT locations_membership_source_check
  CHECK (membership_source IN ('none', 'glofox', 'un1t', 'un1t_online'));

-- contact_memberships.source: the sync's rows beside the operator export's.
ALTER TABLE public.contact_memberships
  DROP CONSTRAINT IF EXISTS contact_memberships_source_check;
ALTER TABLE public.contact_memberships
  ADD CONSTRAINT contact_memberships_source_check
  CHECK (source IN ('un1t_online_export', 'un1t_online_api'));

-- One un1t.online studio is bound to ONE CRM location (the Xero rule, mig 554):
-- the connect route refuses a studio already active elsewhere (409
-- studio_already_connected); this index is the structural backstop. Partial on
-- platform + is_active so a deactivated row never blocks a re-connect.
CREATE UNIQUE INDEX IF NOT EXISTS channel_connections_un1t_online_studio_unique
  ON public.channel_connections (external_account_id)
  WHERE platform = 'un1t_online' AND is_active;

-- ---------------------------------------------------------------------------
-- Self-check: the catalog, never this file's text (mig 153's lesson).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
  d text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'un1t_clients', 'un1t_products', 'un1t_subscriptions', 'un1t_transactions',
    'un1t_invoices', 'un1t_events', 'un1t_bookings', 'un1t_sync_runs'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = 'public' AND c.relname = t AND c.relkind = 'r' AND c.relrowsecurity) THEN
      RAISE EXCEPTION 'mig 726: % missing or RLS off', t;
    END IF;
    IF has_table_privilege('authenticated', 'public.' || t, 'SELECT')
       OR has_table_privilege('anon', 'public.' || t, 'SELECT') THEN
      RAISE EXCEPTION 'mig 726: a client role can SELECT public.%', t;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.table_privileges
                WHERE table_schema = 'public' AND table_name = t
                  AND grantee IN ('anon', 'authenticated')) THEN
      RAISE EXCEPTION 'mig 726: a client role holds a privilege on public.%', t;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = ('public.' || t)::regclass) THEN
      RAISE EXCEPTION 'mig 726: % carries a policy; it must have none', t;
    END IF;
  END LOOP;

  -- Each CHECK admits its new value (and still the old ones).
  d := pg_get_constraintdef((SELECT oid FROM pg_constraint
        WHERE conrelid = 'public.channel_connections'::regclass AND conname = 'channel_connections_platform_check'));
  IF d IS NULL OR d NOT LIKE '%un1t_online%' OR d NOT LIKE '%glofox%' OR d NOT LIKE '%postmark_domain%' THEN
    RAISE EXCEPTION 'mig 726: channel_connections_platform_check wrong: %', d;
  END IF;
  d := pg_get_constraintdef((SELECT oid FROM pg_constraint
        WHERE conrelid = 'public.locations'::regclass AND conname = 'locations_membership_source_check'));
  IF d IS NULL OR d NOT LIKE '%un1t_online%' OR d NOT LIKE '%glofox%' OR d NOT LIKE '%''none''%' THEN
    RAISE EXCEPTION 'mig 726: locations_membership_source_check wrong: %', d;
  END IF;
  d := pg_get_constraintdef((SELECT oid FROM pg_constraint
        WHERE conrelid = 'public.contact_memberships'::regclass AND conname = 'contact_memberships_source_check'));
  IF d IS NULL OR d NOT LIKE '%un1t_online_api%' OR d NOT LIKE '%un1t_online_export%' THEN
    RAISE EXCEPTION 'mig 726: contact_memberships_source_check wrong: %', d;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'contacts'
                  AND indexname = 'contacts_un1t_user_id_unique') THEN
    RAISE EXCEPTION 'mig 726: contacts_un1t_user_id_unique missing';
  END IF;

  d := (SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'channel_connections'
         AND indexname = 'channel_connections_un1t_online_studio_unique');
  IF d IS NULL OR d NOT LIKE 'CREATE UNIQUE INDEX%' OR d NOT LIKE '%external_account_id%'
     OR d NOT LIKE '%un1t_online%' OR d NOT LIKE '%is_active%' THEN
    RAISE EXCEPTION 'mig 726: channel_connections_un1t_online_studio_unique wrong or missing: %', d;
  END IF;
END $$;

COMMIT;
