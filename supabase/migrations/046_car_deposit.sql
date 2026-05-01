-- Car deposit feature.
--
-- Per-car: a tokenised public link (/cars/deposit/<token>) where the
-- buyer accepts T&Cs and pays a deposit via Revolut Merchant. The
-- operator hits a single button on the car detail page to issue
-- (or resend) the link via email + WhatsApp.
--
-- Per-location: editable T&Cs text + version, default deposit amount,
-- and the WhatsApp UTILITY template used to deliver the link.

-- ─── locations: deposit config ────────────────────────────────────

ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS car_deposit_default_amount     NUMERIC(10,2) DEFAULT 500,
  ADD COLUMN IF NOT EXISTS car_deposit_terms              TEXT,
  ADD COLUMN IF NOT EXISTS car_deposit_terms_version      INT DEFAULT 1,
  ADD COLUMN IF NOT EXISTS car_deposit_whatsapp_template_id UUID
    REFERENCES whatsapp_templates(id) ON DELETE SET NULL;

COMMENT ON COLUMN locations.car_deposit_default_amount IS
  'Default EUR deposit amount used when issuing a new deposit link. Operator can override per car.';
COMMENT ON COLUMN locations.car_deposit_terms IS
  'Plain-text or markdown T&Cs shown on the public deposit page. Editable in Settings.';
COMMENT ON COLUMN locations.car_deposit_terms_version IS
  'Bumped each time car_deposit_terms is edited. The version in effect at acceptance time is stamped on cars.deposit_terms_accepted_version for evidence.';
COMMENT ON COLUMN locations.car_deposit_whatsapp_template_id IS
  'WhatsApp UTILITY template used to deliver the deposit link. Body should accept {{1}}=name, {{2}}=amount, {{3}}=car description, {{4}}=link.';

-- ─── cars: deposit state per row ──────────────────────────────────

ALTER TABLE cars
  ADD COLUMN IF NOT EXISTS deposit_token                  UUID UNIQUE,
  ADD COLUMN IF NOT EXISTS deposit_amount                 NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS deposit_link_sent_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deposit_link_sent_via          TEXT,  -- comma-separated: 'email', 'whatsapp', or both
  ADD COLUMN IF NOT EXISTS deposit_terms_accepted_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deposit_terms_accepted_ip      TEXT,
  ADD COLUMN IF NOT EXISTS deposit_terms_accepted_version INT,
  ADD COLUMN IF NOT EXISTS deposit_revolut_order_id       TEXT,
  ADD COLUMN IF NOT EXISTS deposit_revolut_checkout_url   TEXT,
  ADD COLUMN IF NOT EXISTS deposit_status                 TEXT,  -- 'sent' | 'terms_accepted' | 'paid' | 'failed' | 'cancelled' | 'refunded'
  ADD COLUMN IF NOT EXISTS deposit_paid_at                TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deposit_paid_amount            NUMERIC(10,2);

-- Webhook lookups need to find the car by Revolut order id quickly.
-- Partial — most cars don't have an order id, no point indexing nulls.
CREATE INDEX IF NOT EXISTS idx_cars_deposit_revolut_order
  ON cars (deposit_revolut_order_id)
  WHERE deposit_revolut_order_id IS NOT NULL;

-- Public token lookup needs to be O(1). Already UNIQUE (auto-indexed)
-- but make the partial expectation explicit in case of future migration.
CREATE INDEX IF NOT EXISTS idx_cars_deposit_token_lookup
  ON cars (deposit_token)
  WHERE deposit_token IS NOT NULL;

COMMENT ON COLUMN cars.deposit_token IS
  'Unguessable token in the public URL /cars/deposit/<token>. Generated when the operator first issues the link.';
COMMENT ON COLUMN cars.deposit_status IS
  'Lifecycle: NULL = none → sent → terms_accepted → paid (terminal happy path) | failed | cancelled | refunded.';
COMMENT ON COLUMN cars.deposit_terms_accepted_version IS
  'Snapshot of locations.car_deposit_terms_version at the moment of acceptance — proof of what the buyer agreed to.';
