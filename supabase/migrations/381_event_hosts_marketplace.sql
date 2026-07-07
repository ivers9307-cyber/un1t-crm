-- 381: Events hosting-platform foundation — the host (payee) entity + the
-- marketplace money columns. Additive + nullable throughout; existing
-- (internal UN1T) events keep host_id = NULL and continue to settle through
-- Revolut exactly as before. Third-party hosts get a row here with their own
-- Stripe connected account; their events route to Stripe Connect (direct
-- charges, a flat per-ticket booking fee kept by UN1T as the application fee).
--
-- No behaviour change ships with this migration alone — it is the schema
-- foundation the provider-abstraction + Stripe Connect PRs build on.

BEGIN;

-- ── event_hosts — the payee party (EVENTS-HOST.1) ────────────────────────────
CREATE TABLE IF NOT EXISTS event_hosts (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id             UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                        TEXT NOT NULL,
  email                       TEXT,
  -- Payment routing. Internal/UN1T-run events don't need a host row at all
  -- (race_events.host_id = NULL → Revolut). A host row exists for parties who
  -- get paid DIRECTLY: 'stripe_connect' for third parties (their own connected
  -- account), or 'revolut' for a UN1T-owned host brand that still uses Revolut.
  payment_provider            TEXT NOT NULL DEFAULT 'stripe_connect'
                                CHECK (payment_provider IN ('revolut', 'stripe_connect')),
  stripe_connected_account_id TEXT,
  charges_enabled             BOOLEAN NOT NULL DEFAULT FALSE,
  payouts_enabled             BOOLEAN NOT NULL DEFAULT FALSE,
  details_submitted           BOOLEAN NOT NULL DEFAULT FALSE,
  requirements_currently_due  JSONB,
  onboarding_completed_at     TIMESTAMPTZ,
  -- Flat booking fee UN1T keeps PER TICKET, added ON TOP of the ticket price at
  -- checkout (Eventbrite-style): application_fee_amount = platform_fee_cents ×
  -- seats. Default €0. The host still receives their full ticket price (less
  -- Stripe's own processing fee, which the host bears under direct charges).
  platform_fee_cents          INT NOT NULL DEFAULT 0,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_event_hosts_org ON event_hosts (organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_hosts_stripe_acct
  ON event_hosts (stripe_connected_account_id) WHERE stripe_connected_account_id IS NOT NULL;

COMMENT ON TABLE event_hosts IS
  'Event host / payee (EVENTS-HOST.1). NULL race_events.host_id = internal UN1T event (Revolut). A row here = a party paid DIRECTLY: third-party via stripe_connect (own connected account) or a UN1T host brand on revolut. Service-role only (RLS on, no policy) — managed via /api.';
COMMENT ON COLUMN event_hosts.platform_fee_cents IS
  'Flat booking fee UN1T keeps PER TICKET, added on top of the ticket at checkout. application_fee_amount = platform_fee_cents × seats. Default 0.';

-- ── race_events.host_id — optional payee ─────────────────────────────────────
ALTER TABLE race_events
  ADD COLUMN IF NOT EXISTS host_id UUID REFERENCES event_hosts(id) ON DELETE SET NULL;
COMMENT ON COLUMN race_events.host_id IS
  'Optional event host (payee). NULL = internal UN1T event → Revolut (current behaviour). Set = route payments per the host''s payment_provider (stripe_connect → direct charge to the host''s connected account with a per-ticket application fee).';

-- ── marketplace money columns on race_payments + orders ──────────────────────
ALTER TABLE race_payments
  ADD COLUMN IF NOT EXISTS application_fee_cents INT,
  ADD COLUMN IF NOT EXISTS net_to_host_cents     INT,
  ADD COLUMN IF NOT EXISTS connected_account_id  TEXT;
COMMENT ON COLUMN race_payments.application_fee_cents IS
  'stripe_connect payments: the booking fee UN1T kept (application_fee_amount). NULL for Revolut/internal.';
COMMENT ON COLUMN race_payments.net_to_host_cents IS
  'stripe_connect payments: amount credited to the host before Stripe''s processing fee. NULL for Revolut/internal.';

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS application_fee_cents INT,
  ADD COLUMN IF NOT EXISTS net_to_host_cents     INT,
  ADD COLUMN IF NOT EXISTS connected_account_id  TEXT;

-- ── RLS + trigger ────────────────────────────────────────────────────────────
-- Service-role only: every read/write goes through /api (service role bypasses
-- RLS). Enable RLS with no policy so authenticated/anon cannot read host Stripe
-- account ids or fee config directly (matches api_keys / studio_devices etc.).
ALTER TABLE event_hosts ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER event_hosts_updated_at BEFORE UPDATE ON event_hosts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMIT;
