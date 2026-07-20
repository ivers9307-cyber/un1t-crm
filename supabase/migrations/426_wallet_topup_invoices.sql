-- INTEG-C2b — wallet top-up VAT invoices (Stripe one-off Checkout leg).
--
-- Records every wallet top-up as a plain VAT invoice at the POINT OF
-- TOP-UP (Richard's decision 2026-07-19: deliberately NOT
-- voucher/deferred-revenue treatment). The buyer pays the credited
-- amount PLUS 23% Irish VAT (pay X * 1.23 -> wallet credited X cents),
-- so amount_cents is the ex-VAT credit, vat_cents the VAT charged on
-- top, total_cents what the card is charged. Issuer = Champ Fitness
-- Ltd (the decided selling entity, per the SAAS4-W0.2 legal pages).
--
-- Lifecycle: a 'pending' row is inserted BEFORE the Stripe Checkout
-- Session is created (so the invoice number exists to reference in the
-- session), then the session id is stamped on it. The dedicated
-- /api/webhooks/stripe-wallet endpoint moves it pending->paid exactly
-- once (checkout.session.completed; the status guard in the claim
-- UPDATE is the idempotency lock) or pending->expired
-- (checkout.session.expired). 'failed' marks rows whose Checkout
-- Session could not be created at all.
--
-- Numbering: TU-<zero-padded serial> from wallet_topup_invoice_seq, a
-- PLATFORM-WIDE sequence, assigned at INSERT via the column DEFAULT
-- (next_wallet_topup_invoice_number()). Serials are unique and
-- monotonic but not gapless — an aborted insert burns a serial, which
-- is normal sequence behaviour and acceptable for the TU series.
--
-- Access: owners read their org's invoices through the service-role
-- billing routes (org-scoped in app code, 404-not-403). RLS here
-- mirrors the wallets tables' shape (mig 413/420): one permissive
-- master-only SELECT + a restrictive deny-writes for authenticated
-- and anon. Participation is pinning-gated in app code
-- (getLocationPlan() must be non-null to create a top-up), and no
-- location is pinned today, so this migration is zero-behaviour-change
-- machinery.

CREATE SEQUENCE public.wallet_topup_invoice_seq;

-- lpad() TRUNCATES strings longer than the target width, so a naive
-- lpad(n, 5) would corrupt serial 100000 into '10000'. Pad only up to
-- 5 digits, pass longer serials through untouched.
CREATE OR REPLACE FUNCTION public.next_wallet_topup_invoice_number()
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_serial text := nextval('public.wallet_topup_invoice_seq')::text;
BEGIN
  RETURN 'TU-' || lpad(v_serial, GREATEST(char_length(v_serial), 5), '0');
END;
$$;

COMMENT ON FUNCTION public.next_wallet_topup_invoice_number() IS
  'INTEG-C2b: mints the next TU-<zero-padded serial> wallet top-up invoice number from wallet_topup_invoice_seq (platform-wide series). Used as the wallet_topup_invoices.number DEFAULT; service_role-only EXECUTE.';

REVOKE EXECUTE ON FUNCTION public.next_wallet_topup_invoice_number()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.next_wallet_topup_invoice_number()
  TO service_role;

REVOKE ALL ON SEQUENCE public.wallet_topup_invoice_seq FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SEQUENCE public.wallet_topup_invoice_seq TO service_role;

CREATE TABLE public.wallet_topup_invoices (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- RESTRICT, not the wallets tables' CASCADE: these are VAT records
  -- with legal retention duties — deleting a location must not silently
  -- destroy its tax paperwork.
  location_id                 uuid NOT NULL REFERENCES public.locations(id) ON DELETE RESTRICT,
  number                      text NOT NULL UNIQUE DEFAULT public.next_wallet_topup_invoice_number(),
  amount_cents                integer NOT NULL CHECK (amount_cents > 0),
  vat_cents                   integer NOT NULL CHECK (vat_cents >= 0),
  total_cents                 integer NOT NULL CHECK (total_cents = amount_cents + vat_cents),
  currency                    text NOT NULL DEFAULT 'EUR',
  status                      text NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'paid', 'expired', 'failed')),
  stripe_checkout_session_id  text UNIQUE,
  stripe_payment_intent_id    text,
  created_by                  uuid,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  paid_at                     timestamptz
);

COMMENT ON TABLE public.wallet_topup_invoices IS
  'INTEG-C2b wallet top-up VAT invoices (TU-nnnnn, platform-wide serial). One row per attempted Stripe Checkout top-up: amount_cents = the ex-VAT wallet credit, vat_cents = 23% Irish VAT charged ON TOP, total_cents = the card charge. VAT is invoiced at the point of top-up (plain VAT invoice, NOT voucher/deferred-revenue treatment — Richard 2026-07-19). pending->paid exactly once via /api/webhooks/stripe-wallet (status guard = idempotency lock; the paid transition also posts the wallet_apply topup with invoice_ref = number); pending->expired on checkout.session.expired; failed = Checkout Session creation failed. Owner reads go through the org-scoped service-role billing routes, not RLS.';
COMMENT ON COLUMN public.wallet_topup_invoices.amount_cents IS
  'The wallet credit in EUR cents, EX-VAT. This exact amount is what wallet_apply credits on payment.';
COMMENT ON COLUMN public.wallet_topup_invoices.vat_cents IS
  '23% Irish VAT charged on top of amount_cents (rounded half-up in app code; exact for the fixed denominations).';
COMMENT ON COLUMN public.wallet_topup_invoices.number IS
  'TU-<serial> from wallet_topup_invoice_seq, assigned at INSERT by the column DEFAULT. Platform-wide series; unique + monotonic, not gapless.';
COMMENT ON COLUMN public.wallet_topup_invoices.created_by IS
  'Profile id of the acting owner/master. The VAT-invoice email on payment goes to this profile''s email.';

CREATE INDEX idx_wallet_topup_invoices_loc_time
  ON public.wallet_topup_invoices (location_id, created_at DESC);

-- ── RLS — mirror the wallets tables' shape (mig 413/420) ────────────
-- Master-only read for authenticated; restrictive deny for
-- authenticated/anon writes; service-role routes bypass RLS and
-- enforce org scoping in app code. auth_is_master() resolves the
-- caller itself, so no (SELECT auth.uid()) wrap is needed here.

ALTER TABLE public.wallet_topup_invoices ENABLE ROW LEVEL SECURITY;

CREATE POLICY wallet_topup_invoices_select ON public.wallet_topup_invoices
  FOR SELECT TO authenticated
  USING (private.auth_is_master());

CREATE POLICY wallet_topup_invoices_deny_writes ON public.wallet_topup_invoices
  AS RESTRICTIVE FOR ALL TO authenticated, anon
  USING (false) WITH CHECK (false);
