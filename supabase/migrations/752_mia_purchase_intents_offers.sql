-- 752 — MIAHATCH.4: mia_purchase_intents + mia_purchase_offers
-- (Mia at Hatch Street, slice 2: Mia sends a checkout link and books the class
-- once the member has paid; spec 6.5.1 and 6.6).
--
--   mia_purchase_intents  one row per payment link Mia sent. The partial unique
--                         index is the duplicate-link fence (E-6): at most one
--                         'link_sent' row per member per studio, so two
--                         concurrent "send me the link" turns race it and the
--                         loser reads 23505 as "a live intent exists".
--                         success_token_hash holds the hashed /pay-done token;
--                         un1t_write_id points at D's write ledger (no FK:
--                         that table is D's, and the ledger row may be pruned).
--   mia_purchase_offers   the products staff chose to let Mia sell at a studio,
--                         validated by foreign key (product ids are per studio).
--
-- Closed to every client session (mig 677 / mig 726 pattern): RLS on, no
-- policy, nothing for anon/authenticated, the four DML privileges for
-- service_role. Staff reach these through /api routes.
--
-- 'refund_request' (the double-payment staff card) is D's migration to the
-- agent_membership_requests kind CHECK, NOT this one.
--
-- Forward-only, idempotent (IF NOT EXISTS throughout).

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.mia_purchase_intents (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id           uuid        NOT NULL REFERENCES public.locations(id),
  organization_id       uuid        NOT NULL,
  contact_id            uuid        REFERENCES public.contacts(id) ON DELETE SET NULL,
  conversation_id       uuid,
  channel               text        NOT NULL,
  un1t_user_id          text        NOT NULL,
  un1t_product_id       text        NOT NULL,
  product_title         text,
  price_cents           integer,
  event_un1t_id         text,
  class_name            text,
  class_time            text,
  starts_at             timestamptz,
  checkout_url          text,
  success_token_hash    text        UNIQUE,
  status                text        NOT NULL
    CONSTRAINT mia_purchase_intents_status_check
    CHECK (status IN ('link_sent', 'paid', 'booked', 'book_failed', 'no_class', 'expired', 'refused')),
  un1t_write_id         uuid,
  entitlement_snapshot  jsonb,
  outcome               jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  expires_at            timestamptz NOT NULL,
  paid_detected_at      timestamptz,
  detected_by           text,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- One live link per member per studio.
CREATE UNIQUE INDEX IF NOT EXISTS mia_purchase_intents_one_live
  ON public.mia_purchase_intents (location_id, un1t_user_id)
  WHERE status = 'link_sent';

-- The post-sync sweep: live intents past their expiry.
CREATE INDEX IF NOT EXISTS mia_purchase_intents_status_expires
  ON public.mia_purchase_intents (status, expires_at);

CREATE TABLE IF NOT EXISTS public.mia_purchase_offers (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id           uuid        NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  un1t_product_row_id   uuid        NOT NULL REFERENCES public.un1t_products(id) ON DELETE CASCADE,
  sort_order            integer     NOT NULL,
  blurb                 text
    CONSTRAINT mia_purchase_offers_blurb_check
    CHECK (char_length(blurb) <= 140),
  created_by            uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_id, un1t_product_row_id)
);

COMMENT ON TABLE public.mia_purchase_intents IS
  'MIAHATCH.4 (mig 752): one row per payment link Mia sent at a un1t.online studio. Partial unique index mia_purchase_intents_one_live = one live link per member. Service role only.';
COMMENT ON TABLE public.mia_purchase_offers IS
  'MIAHATCH.4 (mig 752): the products staff let Mia sell at a un1t.online studio, in order, with a short blurb. Service role only.';

ALTER TABLE public.mia_purchase_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mia_purchase_offers  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.mia_purchase_intents FROM anon, authenticated;
REVOKE ALL ON public.mia_purchase_offers  FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.mia_purchase_intents TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.mia_purchase_offers  TO service_role;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'mia_purchase_intents'
       AND indexname = 'mia_purchase_intents_one_live'
       AND indexdef ILIKE '%UNIQUE%'
       AND indexdef ILIKE '%(location_id, un1t_user_id)%'
       AND indexdef ILIKE '%status = ''link_sent''%'
  ) THEN
    RAISE EXCEPTION 'mig 752: mia_purchase_intents_one_live is missing or not the partial unique index on (location_id, un1t_user_id) WHERE status = ''link_sent''';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'mia_purchase_intents' AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'mig 752: row level security is not enabled on mia_purchase_intents';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'mia_purchase_offers' AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'mig 752: row level security is not enabled on mia_purchase_offers';
  END IF;
END $$;

COMMIT;
