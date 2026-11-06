-- 813 — HOSTAPPLEPAY.1: heartbeat row for the daily Stripe Connect Apple Pay
-- domain sync.
--
-- /api/cron/stripe-connect-apple-pay-domains (vercel.json "50 4 * * *")
-- registers every checkout domain (CRM hosts, the marketing and host-portal
-- brand hosts, every active tenant_domains host) as a Payment Method Domain on
-- every Stripe connected account (event hosts, studios on Stripe), and
-- re-validates one whose Apple Pay status is not active. Direct charges show
-- Apple Pay only for a domain registered on the CONNECTED account
-- (src/lib/payments/apple-pay-domains.js). The route stamps only when every
-- Stripe call answered and the tenant domains were read; an Apple Pay status
-- Stripe left inactive is reported in last_outcome, not a failure.
--
-- Cadence: daily (86400s) with 93600s (26h) grace, so ONE missed tick never
-- pages; two days without a clean run do. Born healthy (last_ok_at = now()).
--
-- grant: none (no new relation)

INSERT INTO public.cron_heartbeats (name, last_ok_at, expected_interval_seconds, grace_seconds, notes)
VALUES (
  'stripe-connect-apple-pay-domains',
  now(),
  86400,
  93600,
  'HOSTAPPLEPAY.1 — daily /api/cron/stripe-connect-apple-pay-domains (50 4 * * *). Registers our checkout domains as Payment Method Domains on every Stripe connected account so Apple Pay shows on direct-charge checkouts (src/lib/payments/apple-pay-domains.js). Stamped only when every Stripe call answered and tenant_domains was read. STALE = no clean run for two days: read the apple-pay-domains logWarn/logError lines. last_outcome carries { accounts, domains, created, revalidated, apple_pay_inactive, failed_accounts, tenant_read_failed }.'
)
ON CONFLICT (name) DO UPDATE
  SET last_ok_at = now(),
      expected_interval_seconds = EXCLUDED.expected_interval_seconds,
      grace_seconds = EXCLUDED.grace_seconds,
      notes = EXCLUDED.notes;

-- Self-check (POST-state): the row exists on exactly the intended schedule.
DO $$
BEGIN
  PERFORM 1 FROM public.cron_heartbeats h
   WHERE h.name = 'stripe-connect-apple-pay-domains'
     AND h.expected_interval_seconds = 86400
     AND h.grace_seconds = 93600;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mig 813: cron_heartbeats row stripe-connect-apple-pay-domains did not end up on expected_interval_seconds 86400 + grace_seconds 93600; nothing was applied';
  END IF;
END $$;
