-- INTEG-C2a — per-location prepaid usage wallets: schema + append-only
-- ledger + atomic apply RPC + monthly-reset heartbeat seed
-- (Integrations & Monetisation plan; Richard's spec 2026-07-19).
--
-- Model: ONE wallet per location, EUR only. The wallet is a MONTHLY
-- USAGE BUDGET, not stored value — the balance resets to zero at the
-- start of each billing month and unused credit EXPIRES via an
-- explicit 'expiry_reset' ledger entry (never silently). VAT is
-- invoiced at the point of top-up; the Stripe top-up + VAT invoice
-- leg is deliberately NOT in this migration (supervised session).
--
-- The ledger (wallet_transactions) is APPEND-ONLY: rows are never
-- UPDATEd or DELETEd, and wallets.balance_cents is never edited
-- directly — the wallet_apply() RPC below is the ONLY write path
-- (row-locked, ledger + balance in one transaction). Overage draws
-- land as daily rollup posts (one draw per meter per location per
-- day) — the ENFORCEMENT that creates draws is item C3, not here.
--
-- Participation: only locations with an ACTIVE tier pinning in
-- location_plans (mig 413) are touched by the reset cron. Every
-- existing UN1T location is unpinned today, so this migration is
-- zero-behaviour-change machinery.
--
-- RLS mirrors mig 413 exactly: one permissive master-only SELECT
-- policy (private.auth_is_master()) per table + a restrictive
-- deny-writes for authenticated/anon. The RPC is SECURITY INVOKER
-- with EXECUTE revoked from PUBLIC/anon/authenticated and granted
-- only to service_role (the mig 310 pattern — deliberately NOT
-- SECURITY DEFINER, so the advisor's warning class doesn't grow).

CREATE TABLE public.wallets (
  location_id                 uuid PRIMARY KEY REFERENCES public.locations(id) ON DELETE CASCADE,
  balance_cents               integer NOT NULL DEFAULT 0 CHECK (balance_cents >= -1000),
  auto_topup_enabled          boolean NOT NULL DEFAULT false,
  auto_topup_amount_cents     integer,
  auto_topup_threshold_cents  integer,
  period_start                date,
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.wallets IS
  'INTEG-C2a per-location prepaid usage wallet (EUR). Monthly usage budget, NOT stored value: balance resets to 0 at each billing-month boundary via an explicit expiry_reset ledger entry (wallet-monthly-reset cron). balance_cents is NEVER written directly — wallet_apply() is the only write path. The CHECK (>= -1000) is the EUR 10 transactional grace floor as a hard bound. auto_topup_* is dormant config until the Stripe leg ships.';
COMMENT ON COLUMN public.wallets.period_start IS
  'First day of the wallet''s current billing month (Dublin calendar month, v1 — see src/lib/wallet.js for the assumption note). The reset cron advances it after posting the expiry_reset entry; a stale-past-a-boundary value is what makes missed cron days self-healing.';

CREATE TABLE public.wallet_transactions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id          uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  kind                 text NOT NULL CHECK (kind IN ('topup', 'draw', 'adjustment', 'expiry_reset')),
  amount_cents         integer NOT NULL,
  meter                text,
  qty                  integer,
  unit_rate_cents      integer,
  balance_after_cents  integer NOT NULL,
  invoice_ref          text,
  note                 text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid,
  period               date
);

COMMENT ON TABLE public.wallet_transactions IS
  'INTEG-C2a append-only wallet ledger — never UPDATE or DELETE rows; corrections are new ''adjustment'' entries. amount_cents is signed (draws negative, top-ups positive). balance_after_cents snapshots the wallet balance after this entry (written under the wallet row lock in wallet_apply). period = the wallet''s period_start when the entry posted, so an expiry_reset is stamped with the month whose credit expired. Draws carry meter/qty/unit_rate_cents (one draw per meter per location per day, posted by the C3 enforcement rollup — not built yet).';

CREATE INDEX idx_wallet_transactions_loc_time
  ON public.wallet_transactions (location_id, created_at DESC);

-- ── wallet_apply — the ONLY write path ──────────────────────────────
-- Atomic: locks the wallet row (creating it on first use), computes
-- the new balance, enforces the grace floor, inserts the ledger row
-- with balance_after_cents, updates wallets.balance_cents, returns
-- the new balance.
--
-- Kind semantics:
--   topup        p_amount_cents required, > 0
--   draw         p_amount_cents required, < 0 (signed)
--   adjustment   p_amount_cents required, non-zero (either sign)
--   expiry_reset p_amount_cents IGNORED — the applied amount is
--                computed as -balance UNDER THE ROW LOCK so the
--                balance lands on exactly 0 with no read-then-write
--                race (this includes bringing a negative grace-floor
--                balance UP to 0 — settling that debt is the deferred
--                invoice leg's job). A wallet already at 0 is a
--                no-op: returns 0 without inserting a ledger row
--                (nothing expired → nothing to record).
--
-- SECURITY INVOKER (the default, made explicit) + EXECUTE
-- revoked from PUBLIC/anon/authenticated, granted to service_role
-- only: invocable via createServerClient() routes, NOT via
-- /rest/v1/rpc by a signed-in browser. search_path pinned empty,
-- all objects schema-qualified.

CREATE OR REPLACE FUNCTION public.wallet_apply(
  p_location_id uuid,
  p_kind text,
  p_amount_cents integer,
  p_meter text DEFAULT NULL,
  p_qty integer DEFAULT NULL,
  p_unit_rate_cents integer DEFAULT NULL,
  p_invoice_ref text DEFAULT NULL,
  p_note text DEFAULT NULL,
  p_created_by uuid DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_balance integer;
  v_period date;
  v_amount integer;
  v_new_balance integer;
BEGIN
  IF p_location_id IS NULL THEN
    RAISE EXCEPTION 'wallet_apply: p_location_id is required';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('topup', 'draw', 'adjustment', 'expiry_reset') THEN
    RAISE EXCEPTION 'wallet_apply: invalid kind %', p_kind;
  END IF;

  -- First entry for a location creates its wallet row, so later legs
  -- (top-up, enforcement draws) never need a direct table write.
  -- period_start seeds to the current Dublin calendar month.
  INSERT INTO public.wallets (location_id, balance_cents, period_start)
  VALUES (
    p_location_id,
    0,
    (date_trunc('month', (now() AT TIME ZONE 'Europe/Dublin')))::date
  )
  ON CONFLICT (location_id) DO NOTHING;

  SELECT w.balance_cents, w.period_start
    INTO v_balance, v_period
  FROM public.wallets w
  WHERE w.location_id = p_location_id
  FOR UPDATE;

  IF NOT FOUND THEN
    -- Unreachable (the INSERT above created the row or the FK raised),
    -- kept as a hard stop against a future refactor removing the INSERT.
    RAISE EXCEPTION 'wallet_apply: no wallet row for location %', p_location_id;
  END IF;

  IF p_kind = 'expiry_reset' THEN
    IF v_balance = 0 THEN
      RETURN 0;  -- nothing expired; no ledger noise, idempotent rerun
    END IF;
    v_amount := -v_balance;
  ELSE
    IF p_amount_cents IS NULL THEN
      RAISE EXCEPTION 'wallet_apply: p_amount_cents is required for kind %', p_kind;
    END IF;
    IF p_kind = 'topup' AND p_amount_cents <= 0 THEN
      RAISE EXCEPTION 'wallet_apply: topup amount must be positive (got %)', p_amount_cents;
    END IF;
    IF p_kind = 'draw' AND p_amount_cents >= 0 THEN
      RAISE EXCEPTION 'wallet_apply: draw amount must be negative (got %)', p_amount_cents;
    END IF;
    IF p_kind = 'adjustment' AND p_amount_cents = 0 THEN
      RAISE EXCEPTION 'wallet_apply: adjustment amount must be non-zero';
    END IF;
    v_amount := p_amount_cents;
  END IF;

  v_new_balance := v_balance + v_amount;
  IF v_new_balance < -1000 THEN
    RAISE EXCEPTION
      'wallet_apply: grace floor breached for location % (kind=%, meter=%): % + % = % < -1000',
      p_location_id, p_kind, COALESCE(p_meter, '-'), v_balance, v_amount, v_new_balance;
  END IF;

  INSERT INTO public.wallet_transactions
    (location_id, kind, amount_cents, meter, qty, unit_rate_cents,
     balance_after_cents, invoice_ref, note, created_by, period)
  VALUES
    (p_location_id, p_kind, v_amount, p_meter, p_qty, p_unit_rate_cents,
     v_new_balance, p_invoice_ref, p_note, p_created_by, v_period);

  UPDATE public.wallets
  SET balance_cents = v_new_balance,
      updated_at = now()
  WHERE location_id = p_location_id;

  RETURN v_new_balance;
END;
$$;

COMMENT ON FUNCTION public.wallet_apply(uuid, text, integer, text, integer, integer, text, text, uuid) IS
  'INTEG-C2a: the ONLY write path for wallets/wallet_transactions. Row-locks the wallet (creating it on first use), applies a signed amount (expiry_reset computes -balance under the lock → exactly 0), enforces the -1000 grace floor, appends the ledger row and updates the balance atomically. SECURITY INVOKER; service_role-only EXECUTE.';

REVOKE EXECUTE ON FUNCTION public.wallet_apply(uuid, text, integer, text, integer, integer, text, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wallet_apply(uuid, text, integer, text, integer, integer, text, text, uuid)
  TO service_role;

-- ── RLS — mirror mig 413's shape exactly ────────────────────────────
-- Master-only read for authenticated; restrictive deny for
-- authenticated/anon writes; service-role routes bypass RLS and
-- enforce access in app code. auth_is_master() resolves the caller
-- itself, so no (SELECT auth.uid()) wrap is needed here.

ALTER TABLE public.wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallet_transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY wallets_select ON public.wallets
  FOR SELECT TO authenticated
  USING (private.auth_is_master());

CREATE POLICY wallets_deny_writes ON public.wallets
  AS RESTRICTIVE FOR ALL TO authenticated, anon
  USING (false) WITH CHECK (false);

CREATE POLICY wallet_transactions_select ON public.wallet_transactions
  FOR SELECT TO authenticated
  USING (private.auth_is_master());

CREATE POLICY wallet_transactions_deny_writes ON public.wallet_transactions
  AS RESTRICTIVE FOR ALL TO authenticated, anon
  USING (false) WITH CHECK (false);

-- ── Heartbeat seed for the monthly reset cron ───────────────────────
-- The cron RUNS daily at 05:10 UTC (self-gating on the Dublin month
-- boundary) and stamps on every clean run, but the interval here is
-- kept generous (31 days + 3 days grace) so a mid-month pause never
-- pages anyone — what matters is that a month boundary is eventually
-- swept, and missed days self-heal via the stale period_start check.

INSERT INTO public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes)
VALUES (
  'wallet-monthly-reset',
  2678400,   -- 31 days
  259200,    -- 3 days grace
  'INTEG-C2a monthly wallet expiry-reset (daily self-gating cron; acts only at Dublin billing-month boundaries)'
)
ON CONFLICT (name) DO NOTHING;
