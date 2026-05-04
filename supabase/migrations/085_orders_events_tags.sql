-- ============================================================
-- 085: Generic orders + contact_events + contact_tags (Phase 2)
--
-- Three concepts land here:
--
--   1. orders — polymorphic table that houses every paid (or
--      attempted) transaction across the org. source_type +
--      source_id pairs point back at the originating row
--      (race_payments.id or cars.id today). race_payments stays
--      the source of truth for race-specific lifecycle; the orders
--      row is a denormalised projection so the operator-facing
--      Orders tab can list races + cars + future revenue streams
--      in one place. Same shape for retry-detection: when a new
--      completed order matches an earlier failed/abandoned one
--      (same buyer email, same source_type, within 7 days) we link
--      them via retry_of_order_id / superseded_by_order_id.
--
--   2. contact_events — append-only event log per contact (or
--      per-email when no contact_id is known). Drives a tag rules
--      engine (apply rules → upsert contact_tags) which powers
--      retargeting segments (race_completed, lapsed_payer, etc).
--
--   3. contact_tags — current tag state per contact. removed_at
--      nullable so an audit trail is preserved when a tag falls
--      off (rules can re-evaluate without losing history).
--
-- Backfill choices (per Phase 2 design Q4):
--   - Backfill orders from cars.deposit_* + race_payments. cars
--     amounts are NUMERIC majors → multiplied to cents.
--   - DO NOT backfill contact_events. Historical guesswork would
--     pollute the rule engine; events fire forward-only from this
--     migration.
--
-- Match key (Q2): lead buyer email only — race_payments.contact_email
-- (the captain) and cars.buyer_email. Team-member emails on
-- race_payments are NOT considered for retry detection.
--
-- Retry window (Q3): 7 days. Configurable in src/lib/orders.js.
-- ============================================================

BEGIN;

-- ─── orders ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS orders (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id              UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  organization_id          UUID REFERENCES organizations(id) ON DELETE SET NULL,
  -- Polymorphic source. source_type is 'race_registration' (the
  -- race_payment row) or 'car_deposit' (the cars row). Future
  -- types: 'membership', 'merch', etc. source_id is the parent's
  -- primary key — interpret based on source_type.
  source_type              TEXT NOT NULL,
  source_id                UUID NOT NULL,
  -- Buyer identity. contact_id is nullable until the order is
  -- linked to a real contact; contact_email is always populated
  -- (it's the retry-detection key).
  contact_id               UUID REFERENCES contacts(id) ON DELETE SET NULL,
  contact_email            TEXT NOT NULL,
  contact_phone            TEXT,
  contact_name             TEXT,
  -- Money — minor units (cents) throughout. Cars deposits get
  -- multiplied during backfill; race_payments are already cents.
  amount_cents             INT NOT NULL,
  currency                 TEXT NOT NULL DEFAULT 'EUR',
  -- Lifecycle. 'recovered' is a derived state — a failed/abandoned
  -- order whose superseded_by_order_id points at a later completed
  -- order. The Orders tab lists recovered rows in their own tab so
  -- the failed/abandoned tabs only show genuine non-recoveries.
  status                   TEXT NOT NULL,
  -- Provider integration (mirrors race_payments shape).
  payment_provider         TEXT,
  payment_provider_ref     TEXT,
  -- Retry chain pointers — set when retry-recovery fires.
  -- retry_of_order_id: the older failed/abandoned order this one recovered
  -- superseded_by_order_id: the inverse — set on the older row pointing forward
  retry_of_order_id        UUID REFERENCES orders(id) ON DELETE SET NULL,
  superseded_by_order_id   UUID REFERENCES orders(id) ON DELETE SET NULL,
  -- Timestamps. Lifecycle events get their own *_at column so the
  -- whole timeline lives on one row.
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at             TIMESTAMPTZ,
  failed_at                TIMESTAMPTZ,
  abandoned_at             TIMESTAMPTZ,
  refunded_at              TIMESTAMPTZ,
  refunded_amount_cents    INT,
  -- Free-form metadata (UTM, referrer, source-specific summary).
  metadata                 JSONB,
  -- One source row maps to one orders row. UPSERT on source_type +
  -- source_id is what the sync helpers use.
  CONSTRAINT orders_source_unique UNIQUE (source_type, source_id),
  CONSTRAINT orders_status_check
    CHECK (status IN ('pending', 'completed', 'failed', 'abandoned', 'refunded', 'recovered')),
  CONSTRAINT orders_source_type_check
    CHECK (source_type IN ('race_registration', 'car_deposit'))
);

COMMENT ON TABLE orders IS
  'Generic order ledger across all revenue streams (race signups, car deposits, future memberships). Polymorphic via source_type + source_id pointing back to race_payments or cars. Powers the operator Orders tab + retry detection (mig 085). The source-specific tables remain the lifecycle source of truth — orders rows are kept in sync via src/lib/orders.js helpers fired from the same code paths that mutate the source.';

COMMENT ON COLUMN orders.source_type IS
  'race_registration → source_id is race_payments.id. car_deposit → source_id is cars.id. Future types extend the CHECK constraint.';

COMMENT ON COLUMN orders.status IS
  'pending → (completed | failed | abandoned | refunded). recovered is derived — set when a failed/abandoned order is superseded by a later completed one (same buyer email, same source_type, within RETRY_WINDOW_DAYS = 7 in src/lib/orders.js).';

COMMENT ON COLUMN orders.contact_email IS
  'The lead buyer email — race_payments.contact_email (captain) or cars.buyer_email. Used as the retry-detection match key. Team-member emails on race_payments are NOT considered.';

CREATE INDEX IF NOT EXISTS idx_orders_location ON orders (location_id);
CREATE INDEX IF NOT EXISTS idx_orders_location_status ON orders (location_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_source ON orders (source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_orders_contact ON orders (contact_id) WHERE contact_id IS NOT NULL;
-- Powers retry-detection lookups: same email + status (failed|abandoned)
-- within 7d. Partial index keeps it tight (most orders are completed).
CREATE INDEX IF NOT EXISTS idx_orders_retry_lookup
  ON orders (contact_email, source_type, status, created_at)
  WHERE status IN ('failed', 'abandoned');
CREATE INDEX IF NOT EXISTS idx_orders_retry_chain
  ON orders (retry_of_order_id) WHERE retry_of_order_id IS NOT NULL;

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS orders_location_scoped ON orders;
CREATE POLICY orders_location_scoped ON orders
  FOR ALL
  TO authenticated
  USING (private.auth_is_master() OR private.auth_is_in_location(location_id))
  WITH CHECK (private.auth_is_master() OR private.auth_is_in_location(location_id));

CREATE OR REPLACE FUNCTION private.touch_orders_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN NEW.updated_at := NOW(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS orders_touch_updated_at ON orders;
CREATE TRIGGER orders_touch_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION private.touch_orders_updated_at();

-- ─── contact_events ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS contact_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id      UUID REFERENCES contacts(id) ON DELETE SET NULL,
  -- Always populated even when contact_id is null — the rules
  -- engine groups by email when no contact link exists yet.
  contact_email   TEXT NOT NULL,
  location_id     UUID REFERENCES locations(id) ON DELETE SET NULL,
  event_type      TEXT NOT NULL,
  event_metadata  JSONB,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_type     TEXT,
  source_id       UUID
);

COMMENT ON TABLE contact_events IS
  'Append-only event log per buyer. Drives the tag rules engine (src/lib/contact-events.js). Initial taxonomy (mig 085): order.created/completed/failed/abandoned/recovered, race.registered/checked_in/started/finished/no_show, member.validated/validation_failed. Time-anchored events (race.starts_in_24h, race.completed_24h_ago) are emitted by a scheduled cron — see /api/cron/race-timing-events.';

CREATE INDEX IF NOT EXISTS idx_contact_events_contact_time
  ON contact_events (contact_id, occurred_at DESC) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contact_events_email_time
  ON contact_events (contact_email, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_contact_events_location_type
  ON contact_events (location_id, event_type, occurred_at DESC);
-- Idempotency for time-anchored events: the cron emits one row per
-- (registration, milestone) and the partial unique constraint
-- prevents re-emission on retries.
CREATE UNIQUE INDEX IF NOT EXISTS uq_contact_events_time_anchored
  ON contact_events (source_type, source_id, event_type)
  WHERE event_type IN (
    'race.starts_in_24h', 'race.starts_in_1h',
    'race.completed_24h_ago', 'race.completed_7d_ago'
  );

ALTER TABLE contact_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS contact_events_location_scoped ON contact_events;
CREATE POLICY contact_events_location_scoped ON contact_events
  FOR ALL
  TO authenticated
  USING (
    private.auth_is_master()
    OR location_id IS NULL  -- pre-link events readable to any auth'd user
    OR private.auth_is_in_location(location_id)
  )
  WITH CHECK (
    private.auth_is_master()
    OR location_id IS NULL
    OR private.auth_is_in_location(location_id)
  );

-- ─── contact_tags ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS contact_tags (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id  UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  location_id UUID REFERENCES locations(id) ON DELETE SET NULL,
  tag         TEXT NOT NULL,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  removed_at  TIMESTAMPTZ,
  -- Active = removed_at IS NULL. The (contact_id, tag) UNIQUE
  -- constraint over the partial index ensures only ONE active row
  -- per pair. History is preserved by leaving the closed-out rows
  -- in the table.
  metadata    JSONB
);

COMMENT ON TABLE contact_tags IS
  'Machine-derived tags powering retargeting segments. Active tags = removed_at IS NULL. Tag set is the closed list from src/lib/contact-events.js TAG_RULES (mig 085). The /segments page lists each known tag with its active count and a "send broadcast" button.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_contact_tags_active
  ON contact_tags (contact_id, tag) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_contact_tags_location_tag
  ON contact_tags (location_id, tag) WHERE removed_at IS NULL;

ALTER TABLE contact_tags ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS contact_tags_location_scoped ON contact_tags;
CREATE POLICY contact_tags_location_scoped ON contact_tags
  FOR ALL
  TO authenticated
  USING (
    private.auth_is_master()
    OR location_id IS NULL
    OR private.auth_is_in_location(location_id)
  )
  WITH CHECK (
    private.auth_is_master()
    OR location_id IS NULL
    OR private.auth_is_in_location(location_id)
  );

-- ─── backfill: cars.deposit_* → orders ───────────────────────────
-- Cars amounts are NUMERIC majors. *100 to get cents. Map
-- deposit_status to the orders enum:
--   paid → completed; failed → failed; cancelled → abandoned;
--   refunded → refunded; sent / terms_accepted → pending.

INSERT INTO orders (
  location_id, organization_id, source_type, source_id,
  contact_email, contact_phone, contact_name,
  amount_cents, currency, status,
  payment_provider, payment_provider_ref,
  created_at, completed_at, failed_at, refunded_at,
  metadata
)
SELECT
  c.location_id,
  l.organization_id,
  'car_deposit',
  c.id,
  COALESCE(c.buyer_email, '<unknown>'),
  c.buyer_phone,
  c.buyer_name,
  COALESCE(ROUND((COALESCE(c.deposit_paid_amount, c.deposit_amount, 0)) * 100)::INT, 0),
  'EUR',
  CASE c.deposit_status
    WHEN 'paid' THEN 'completed'
    WHEN 'failed' THEN 'failed'
    WHEN 'cancelled' THEN 'abandoned'
    WHEN 'refunded' THEN 'refunded'
    ELSE 'pending'
  END,
  CASE WHEN c.deposit_revolut_order_id IS NOT NULL THEN 'revolut' ELSE NULL END,
  c.deposit_revolut_order_id,
  COALESCE(c.deposit_link_sent_at, c.created_at, NOW()),
  c.deposit_paid_at,
  CASE WHEN c.deposit_status = 'failed' THEN COALESCE(c.deposit_link_sent_at, c.created_at) ELSE NULL END,
  CASE WHEN c.deposit_status = 'refunded' THEN COALESCE(c.deposit_paid_at, c.deposit_link_sent_at) ELSE NULL END,
  jsonb_build_object(
    'backfilled', true,
    'car_make', c.make,
    'car_model', c.model,
    'irish_reg', c.irish_reg
  )
FROM cars c
LEFT JOIN locations l ON l.id = c.location_id
WHERE c.deposit_status IS NOT NULL
  AND c.buyer_email IS NOT NULL
ON CONFLICT (source_type, source_id) DO NOTHING;

-- ─── backfill: race_payments → orders ────────────────────────────

INSERT INTO orders (
  location_id, organization_id, source_type, source_id,
  contact_id, contact_email, contact_phone, contact_name,
  amount_cents, currency, status,
  payment_provider, payment_provider_ref,
  created_at, completed_at, failed_at, abandoned_at, refunded_at,
  metadata
)
SELECT
  re.location_id,
  l.organization_id,
  'race_registration',
  rp.id,
  rp.contact_id,
  rp.contact_email,
  rp.contact_phone,
  rp.contact_name,
  rp.amount_cents,
  rp.currency,
  rp.status,  -- already in our enum: pending|completed|failed|abandoned|refunded
  rp.payment_provider,
  rp.payment_provider_ref,
  rp.created_at,
  rp.completed_at,
  rp.failed_at,
  rp.abandoned_at,
  rp.refunded_at,
  jsonb_build_object(
    'backfilled', true,
    'race_event_id', rp.race_event_id,
    'race_registration_id', rp.race_registration_id
  )
FROM race_payments rp
JOIN race_events re ON re.id = rp.race_event_id
LEFT JOIN locations l ON l.id = re.location_id
ON CONFLICT (source_type, source_id) DO NOTHING;

-- Note: retry-detection is NOT run during backfill. We only set up
-- the link going forward — historical "this was actually a retry of
-- that" relationships would require careful logic and operators
-- haven't asked for it. The lookup index exists so future ad-hoc
-- queries can derive the chains if needed.

-- ─── pg_cron: race timing events ─────────────────────────────────
-- Runs every 15 minutes. Emits time-anchored race events
-- (race.starts_in_24h / _1h, race.completed_24h_ago) so the rules
-- engine can drive retargeting tags. Same auth pattern as the other
-- crons (CRON_SECRET in private.app_config).

DO $$
BEGIN
  PERFORM cron.unschedule('race-timing-events');
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$$;

SELECT cron.schedule(
  'race-timing-events',
  '*/15 * * * *',
  $$
  SELECT net.http_get(
    url := (SELECT value FROM private.app_config WHERE key = 'cron_base_url')
           || '/api/cron/race-timing-events',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT value FROM private.app_config WHERE key = 'cron_secret')
    )
  );
  $$
);

COMMIT;
