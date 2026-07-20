-- SAAS4-M2 — usage rollup machinery + optional per-org hard caps
-- (SaaS machinery plan §3; decisions settled 2026-07-19).
-- Renumbered 413→415→421 (repo cleanup): 413/414/415 collided with
-- parallel 2026-07-19 sessions (413_plans_and_pricing + 420_wallets
-- shipped independently) — the mig-350 precedent.
--
-- 1. org_settings gains two OPTIONAL hard-cap knobs (NULL = no cap =
--    zero behaviour change). The plan allowance is the SOFT band
--    (overage accrues, nothing stops — billing build B1); these hard
--    caps are the only thing that interrupts service: Mia pauses /
--    campaign starts refuse.
-- 2. rollup_usage_for_day(day): SQL-side aggregation into
--    usage_rollups_daily — SQL because usage_events can exceed the
--    PostgREST 1k-row select cap and supabase-js cannot GROUP BY.
--    Meters: anthropic_tokens (from usage_events) + email_send /
--    sms_send / wa_template_send (derived from their existing
--    location-tagged ledgers — never double-written).
-- 3. org_ai_spend_month_cents / org_email_sends_month: LIVE month
--    sums for the cap checks (no rollup-lag drift). AI spend excludes
--    source 'assistant_chat' (staff assistant: metered, not counted).
-- 4. cron_heartbeats seed for the new usage-rollup cron.
--
-- Days are Dublin calendar days ((ts AT TIME ZONE 'Europe/Dublin')::date)
-- matching the repo's business-day convention.
-- usage_events rows with no location_id (e.g. hunt_scoring) cannot fit
-- the rollup PK and are excluded from rollups; the live spend function
-- includes them only when they carry organization_id directly.

ALTER TABLE org_settings
  ADD COLUMN ai_hard_cap_cents NUMERIC
    CHECK (ai_hard_cap_cents IS NULL OR ai_hard_cap_cents > 0),
  ADD COLUMN email_hard_cap_sends INTEGER
    CHECK (email_hard_cap_sends IS NULL OR email_hard_cap_sends > 0);

COMMENT ON COLUMN org_settings.ai_hard_cap_cents IS
  'SAAS4-M2 optional HARD monthly AI-spend cap (cents, Dublin calendar month). NULL = no cap. At cap: Mia pauses with operator notice (staff assistant unaffected). Soft allowances/overage live in the billing layer.';
COMMENT ON COLUMN org_settings.email_hard_cap_sends IS
  'SAAS4-M2 optional HARD monthly email-send cap (sent email_sends rows, Dublin month). NULL = no cap. At cap: new campaign starts are refused; sequences/transactional unaffected.';

-- ── Rollup ─────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.rollup_usage_for_day(p_day date)
RETURNS void
LANGUAGE sql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  -- AI tokens (from the usage_events ledger)
  INSERT INTO usage_rollups_daily (organization_id, location_id, meter, day, quantity, cost_cents, updated_at)
  SELECT l.organization_id, ue.location_id, 'anthropic_tokens', p_day,
         SUM(ue.quantity), SUM(COALESCE(ue.cost_estimate_cents, 0)), NOW()
  FROM usage_events ue
  JOIN locations l ON l.id = ue.location_id
  WHERE ue.meter = 'anthropic_tokens'
    AND (ue.occurred_at AT TIME ZONE 'Europe/Dublin')::date = p_day
  GROUP BY l.organization_id, ue.location_id
  ON CONFLICT (organization_id, location_id, meter, day)
  DO UPDATE SET quantity = EXCLUDED.quantity, cost_cents = EXCLUDED.cost_cents, updated_at = NOW();

  -- Email sends (derived from email_sends)
  INSERT INTO usage_rollups_daily (organization_id, location_id, meter, day, quantity, updated_at)
  SELECT l.organization_id, es.location_id, 'email_send', p_day, COUNT(*), NOW()
  FROM email_sends es
  JOIN locations l ON l.id = es.location_id
  WHERE es.sent_at IS NOT NULL
    AND (es.sent_at AT TIME ZONE 'Europe/Dublin')::date = p_day
  GROUP BY l.organization_id, es.location_id
  ON CONFLICT (organization_id, location_id, meter, day)
  DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = NOW();

  -- SMS sends (derived from the location-tagged activities rows)
  INSERT INTO usage_rollups_daily (organization_id, location_id, meter, day, quantity, updated_at)
  SELECT l.organization_id, a.location_id, 'sms_send', p_day, COUNT(*), NOW()
  FROM activities a
  JOIN locations l ON l.id = a.location_id
  WHERE a.type = 'sms_sent'
    AND (a.created_at AT TIME ZONE 'Europe/Dublin')::date = p_day
  GROUP BY l.organization_id, a.location_id
  ON CONFLICT (organization_id, location_id, meter, day)
  DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = NOW();

  -- WhatsApp template sends (business-initiated; mirrors whatsapp-budget's basis)
  INSERT INTO usage_rollups_daily (organization_id, location_id, meter, day, quantity, updated_at)
  SELECT l.organization_id, wm.location_id, 'wa_template_send', p_day, COUNT(*), NOW()
  FROM whatsapp_messages wm
  JOIN locations l ON l.id = wm.location_id
  WHERE wm.direction = 'outbound'
    AND wm.message_type = 'template'
    AND (wm.sent_at AT TIME ZONE 'Europe/Dublin')::date = p_day
  GROUP BY l.organization_id, wm.location_id
  ON CONFLICT (organization_id, location_id, meter, day)
  DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = NOW();
$$;

-- ── Live month sums for the cap checks ─────────────────────────────

CREATE OR REPLACE FUNCTION public.org_ai_spend_month_cents(p_org uuid, p_month_start date)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(SUM(ue.cost_estimate_cents), 0)
  FROM usage_events ue
  LEFT JOIN locations l ON l.id = ue.location_id
  WHERE COALESCE(ue.organization_id, l.organization_id) = p_org
    AND ue.meter = 'anthropic_tokens'
    AND ue.source <> 'assistant_chat'
    AND (ue.occurred_at AT TIME ZONE 'Europe/Dublin')::date >= p_month_start;
$$;

CREATE OR REPLACE FUNCTION public.org_email_sends_month(p_org uuid, p_month_start date)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT COUNT(*)
  FROM email_sends es
  JOIN locations l ON l.id = es.location_id
  WHERE l.organization_id = p_org
    AND es.sent_at IS NOT NULL
    AND (es.sent_at AT TIME ZONE 'Europe/Dublin')::date >= p_month_start;
$$;

-- Keep the functions off the anon/authenticated PostgREST RPC surface
-- (the mig 022 lesson); the service role is the only caller.
REVOKE EXECUTE ON FUNCTION public.rollup_usage_for_day(date) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.org_ai_spend_month_cents(uuid, date) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.org_email_sends_month(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rollup_usage_for_day(date) TO service_role;
GRANT EXECUTE ON FUNCTION public.org_ai_spend_month_cents(uuid, date) TO service_role;
GRANT EXECUTE ON FUNCTION public.org_email_sends_month(uuid, date) TO service_role;

-- ── Heartbeat seed for the new cron ────────────────────────────────

INSERT INTO cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes)
VALUES ('usage-rollup', 86400, 10800,
        'SAAS4-M2 nightly usage rollup (02:40 UTC): usage_events + derived email/sms/wa meters -> usage_rollups_daily for yesterday + today (Dublin).')
ON CONFLICT (name) DO NOTHING;
