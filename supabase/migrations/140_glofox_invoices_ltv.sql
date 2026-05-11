-- GLOFOX2.1.20 — webhook-driven Lifetime Value tracking.
--
-- We pivoted from the /Analytics/report API approach (Tier 3 #9
-- original plan) because that endpoint consistently returns 0
-- transactions for our credentials — almost certainly a Glofox
-- API permission scope issue. Instead, accumulate LTV in real-
-- time from the INVOICE_UPDATED webhook (which the operator is
-- subscribing to anyway in Tier 2).
--
-- Two structures:
--
-- 1. glofox_invoices — source-of-truth table mirroring the events.
--    UNIQUE on Glofox's invoice id makes the receiver idempotent
--    (Glofox retries the same INVOICE_UPDATED on status changes —
--    PENDING → PAID → maybe FORGIVEN — and we want to overwrite,
--    not duplicate).
--
-- 2. contacts.lifetime_value_cents + cohort columns — denormalised
--    aggregates the AudienceBuilder can filter on without joining
--    glofox_invoices for every audience evaluation.
--
-- Recompute strategy: on each INVOICE_UPDATED, upsert the row in
-- glofox_invoices, then recompute the affected contact's
-- aggregates from scratch (SUM/COUNT/MAX over their rows). Simpler
-- than incremental tracking + survives any out-of-order delivery.

-- ─────────────────────────────────────────────────────────────
-- Source-of-truth table
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS glofox_invoices (
  id                TEXT PRIMARY KEY,                -- Glofox invoice id
  contact_id        UUID REFERENCES contacts(id) ON DELETE CASCADE,
  location_id       UUID REFERENCES locations(id),
  glofox_user_id    TEXT,
  amount_cents      BIGINT NOT NULL DEFAULT 0,
  currency          TEXT,
  status            TEXT NOT NULL,                   -- PAID / PAST_DUE / PENDING / FORGIVEN
  payment_method    TEXT,
  document_type     TEXT,
  -- Comma-separated for ease of audience-filtering "members who
  -- paid for SUBSCRIPTION_PAYMENT in the last 30 days" — we don't
  -- need full line-item granularity in the aggregate.
  line_item_subtypes TEXT,
  invoice_date      TIMESTAMPTZ,
  raw_payload       JSONB,                           -- full event for forensic
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_glofox_invoices_contact ON glofox_invoices (contact_id);
CREATE INDEX IF NOT EXISTS idx_glofox_invoices_location ON glofox_invoices (location_id);
CREATE INDEX IF NOT EXISTS idx_glofox_invoices_status ON glofox_invoices (status);
CREATE INDEX IF NOT EXISTS idx_glofox_invoices_invoice_date ON glofox_invoices (invoice_date);

-- ─────────────────────────────────────────────────────────────
-- Denormalised aggregates on contacts
-- ─────────────────────────────────────────────────────────────
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS lifetime_value_cents       BIGINT DEFAULT 0;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS lifetime_transaction_count INT DEFAULT 0;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS lifetime_currency          TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_payment_at            TIMESTAMPTZ;
-- last_invoice_at differs from last_payment_at — captures any-status
-- invoice activity (PAST_DUE, PENDING, FORGIVEN) so the operator can
-- see "Glofox last invoiced this person 3 days ago even though they
-- haven't paid yet" — at-risk signal.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_invoice_at            TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_contacts_lifetime_value ON contacts (lifetime_value_cents);
CREATE INDEX IF NOT EXISTS idx_contacts_last_payment_at ON contacts (last_payment_at);

-- ─────────────────────────────────────────────────────────────
-- RLS — invoices follow the same per-location scoping as contacts
-- ─────────────────────────────────────────────────────────────
ALTER TABLE glofox_invoices ENABLE ROW LEVEL SECURITY;

CREATE POLICY glofox_invoices_select ON glofox_invoices
  FOR SELECT USING (
    location_id IN (
      SELECT location_id FROM profile_locations WHERE profile_id = auth.uid()
    )
  );

-- Service role does the writes (webhook receiver). No INSERT/UPDATE
-- policy for authenticated users — they read only.
