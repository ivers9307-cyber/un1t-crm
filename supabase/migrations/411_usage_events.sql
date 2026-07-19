-- SAAS4-M1 — per-tenant usage metering (SaaS machinery plan §3).
--
-- usage_events: append-only ledger for consumption with NO existing
-- per-send table — today that's Anthropic tokens (7 raw-fetch call
-- sites, captured via src/lib/anthropic.js → src/lib/usage.js). Email,
-- SMS and WhatsApp volumes are NOT written here: they already have
-- location-tagged ledgers (email_sends / activities type='sms_sent' /
-- whatsapp_messages) and the rollup cron (SAAS4-M2) derives them.
--
-- usage_rollups_daily: the aggregation both the caps check and the
-- operator usage page read, maintained by the nightly rollup cron
-- (SAAS4-M2). organization_id is resolved at rollup time via
-- locations.organization_id when the raw event carries only a
-- location (org-level events, e.g. hunt scoring, carry it directly).
--
-- Service-role only: RLS enabled with NO policies (the mig 364
-- pattern) — routes read/write via createServerClient(); there is no
-- browser-direct surface for metering data.

CREATE TABLE usage_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
  location_id UUID REFERENCES locations(id) ON DELETE SET NULL,
  meter TEXT NOT NULL,
  source TEXT NOT NULL,
  quantity NUMERIC NOT NULL,
  cost_estimate_cents NUMERIC,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb
);

COMMENT ON TABLE usage_events IS
  'SAAS4-M1 append-only usage ledger. meter=anthropic_tokens today; quantity = input+output tokens; cache token detail in meta. cost_estimate_cents is an ESTIMATE for operator visibility/caps — the vendor invoice is billing truth.';
COMMENT ON COLUMN usage_events.source IS
  'Stable call-site key: mia_auto_reply | assistant_chat | invoice_ocr | followups | approval_suggest | hunt_scoring | flow_agent. assistant_chat is metered but allowance-exempt (Richard 2026-07-19: track now, allocate cost ~Oct).';

CREATE INDEX idx_usage_events_org_meter_time
  ON usage_events (organization_id, meter, occurred_at);
CREATE INDEX idx_usage_events_loc_meter_time
  ON usage_events (location_id, meter, occurred_at);

ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;

CREATE TABLE usage_rollups_daily (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  meter TEXT NOT NULL,
  day DATE NOT NULL,
  quantity NUMERIC NOT NULL DEFAULT 0,
  cost_cents NUMERIC,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, location_id, meter, day)
);

COMMENT ON TABLE usage_rollups_daily IS
  'SAAS4-M1 daily per-tenant usage aggregates, maintained by the rollup cron (SAAS4-M2). Feeds the caps check, /settings/usage, the tenant-health view, and (later) Stripe overage lines. Meters: anthropic_tokens + derived email_send/sms_send/wa_template_send.';

ALTER TABLE usage_rollups_daily ENABLE ROW LEVEL SECURITY;
