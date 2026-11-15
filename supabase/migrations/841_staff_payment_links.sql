-- 841 — PAYLINK.1: staff-sent un1t.online payment links (Hatch Street).
--
-- A staff member sends a customer a link to a un1t.online product on WhatsApp.
-- The customer opens /buy/<token>, accepts the terms themselves and is sent to
-- un1t.online's hosted checkout. The CRM never charges a card. This table is
-- the one record of each link: who it was sent to, what it offers, where it
-- stands, and whether the un1t.online transaction that paid it has landed.
--
-- Spec: docs/superpowers/specs/2026-11-15-hatch-payment-link-design.md.
--
-- Lifecycle (status):
--   sent              link created and the WhatsApp template accepted by Meta
--   opened            the customer loaded the page (GET stamps opened_at only)
--   checkout_started  a hosted checkout link was minted for the customer
--   paid              a un1t_transactions row matched the link (terminal)
--   expired           past expires_at, or the product is no longer sellable (terminal)
--   revoked           a newer link replaced it, or staff withdrew it (terminal)
--
-- One LIVE link per contact per studio: the partial unique index below is the
-- database's own refusal of a second live row, so a racing send cannot leave
-- two links both working. A new send revokes the previous live row first.
--
-- token_hash is sha256 hex of the link token. The token itself is never stored,
-- and neither is the checkout URL.
--
-- Closed to every client session: RLS on with no policy, and REVOKE ALL from
-- anon and authenticated. Written and read only by service-role code (the
-- staff send route, the public /buy/ routes, the settle sweep).
--
-- ROLLBACK: drop the table only after the code that reads it is reverted. No
-- other table references it.

BEGIN;

-- CREATE TABLE and the indexes take ACCESS EXCLUSIVE on a new relation only
-- briefly, but fail after 5 s rather than queue behind anything unexpected.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.staff_payment_links (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id            uuid        NOT NULL REFERENCES public.locations(id),
  organization_id        uuid        NOT NULL,
  contact_id             uuid        NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  un1t_product_id        text        NOT NULL,
  product_title          text,
  price_cents            integer,
  token_hash             text        NOT NULL UNIQUE,
  status                 text        NOT NULL
    CHECK (status IN ('sent', 'opened', 'checkout_started', 'paid', 'expired', 'revoked')),
  un1t_user_id           text,
  terms_accepted_at      timestamptz,
  checkout_count         integer     NOT NULL DEFAULT 0,
  last_checkout_ledger_id uuid,
  paid_transaction_id    text,
  paid_at                timestamptz,
  opened_at              timestamptz,
  whatsapp_message_id    text,
  last_error             text,
  created_by             uuid,
  created_at             timestamptz NOT NULL DEFAULT now(),
  expires_at             timestamptz NOT NULL,
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- One live link per contact per studio (sent, opened or checkout_started).
CREATE UNIQUE INDEX IF NOT EXISTS staff_payment_links_one_live
  ON public.staff_payment_links (location_id, contact_id)
  WHERE status IN ('sent', 'opened', 'checkout_started');

-- The settle sweep and the expiry pass both read live rows by status and age.
CREATE INDEX IF NOT EXISTS staff_payment_links_status_expires_idx
  ON public.staff_payment_links (status, expires_at);

ALTER TABLE public.staff_payment_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.staff_payment_links FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.staff_payment_links TO service_role;

COMMENT ON TABLE public.staff_payment_links IS
  'PAYLINK.1: staff-sent un1t.online payment links. Stores only the sha256 of the link token and never the checkout URL. Service role only (RLS on, no policy).';

-- Self-check (POST-state): the table is closed to client sessions and RLS is on.
DO $$
BEGIN
  PERFORM 1 FROM pg_class c
   WHERE c.oid = 'public.staff_payment_links'::regclass
     AND c.relrowsecurity = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mig 841: public.staff_payment_links is missing or has RLS off; nothing was applied';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.table_privileges p
     WHERE p.table_schema = 'public'
       AND p.table_name = 'staff_payment_links'
       AND p.grantee IN ('anon', 'authenticated')
  ) THEN
    RAISE EXCEPTION 'mig 841: anon or authenticated still holds a privilege on public.staff_payment_links; nothing was applied';
  END IF;
END $$;

COMMIT;
