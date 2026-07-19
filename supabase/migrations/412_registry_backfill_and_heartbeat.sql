-- 412: INTEG-A2 — connections-registry backfill (dual-read phase) +
-- INTEG-A3 heartbeat seed.
--
-- Phase A1 (mig 411) widened channel_connections into the per-location
-- connections registry. This migration seeds it from today's legacy
-- storage so dual-read code (src/lib/connection-registry.js) finds a
-- registry row wherever legacy config exists:
--
--   provider        legacy source                          registry mapping
--   ─────────       ────────────────────────────────       ───────────────────────────
--   glofox          locations.settings->'glofox'           branch_id → external_account_id
--                                                          api_key → access_token
--                                                          webhook_secret → app_secret
--                                                          everything else (api_token,
--                                                          namespace, trial_*, hidden_
--                                                          class_keywords, …) → config
--   unifi           locations.settings->'unifi'            api_token → access_token
--                                                          everything else (host,
--                                                          *_policy_id, allow_self_
--                                                          signed, controller_id) → config
--   sensibo         locations.sensibo_api_key /            sensibo_api_key → access_token
--                   locations.sensibo_pod_id               pod_id → config
--   thinq           locations.thinq_pat /                  thinq_pat → access_token
--                   thinq_client_id / thinq_country_code   client_id, country_code → config
--   twilio_sender   locations.twilio_alpha_sender_id       sender_id → config
--   bca             locations.bca_config                   whole object → config
--
-- Idempotent: each INSERT..SELECT is guarded by NOT EXISTS on the
-- active (location_id, platform) pair — the one-active partial unique
-- index (idx_channel_connections_one_active, mig 230) can't back an
-- ON CONFLICT target, so NOT EXISTS carries the idempotency.
--
-- NO legacy columns/keys are dropped or rewritten — explicitly
-- deferred until the write paths move to the registry (the settings
-- tabs keep writing legacy; /api/locations/[id]/connections/refresh
-- re-syncs registry rows after a legacy save). WhatsApp / Xero /
-- Instagram / ad_accounts are untouched.

-- ── glofox ──────────────────────────────────────────────────────────
INSERT INTO public.channel_connections
  (location_id, platform, external_account_id, access_token, app_secret, config, status, is_active)
SELECT
  l.id,
  'glofox',
  NULLIF(l.settings->'glofox'->>'branch_id', ''),
  NULLIF(l.settings->'glofox'->>'api_key', ''),
  NULLIF(l.settings->'glofox'->>'webhook_secret', ''),
  (l.settings->'glofox') - 'branch_id' - 'api_key' - 'webhook_secret',
  'connected',
  true
FROM public.locations l
WHERE jsonb_typeof(l.settings->'glofox') = 'object'
  AND l.settings->'glofox' <> '{}'::jsonb
  AND NOT EXISTS (
    SELECT 1 FROM public.channel_connections cc
    WHERE cc.location_id = l.id AND cc.platform = 'glofox' AND cc.is_active
  );

-- ── unifi (Access; settings.unifi_protect is a separate sibling key
--    and is NOT part of the registry yet) ────────────────────────────
INSERT INTO public.channel_connections
  (location_id, platform, access_token, config, status, is_active)
SELECT
  l.id,
  'unifi',
  NULLIF(l.settings->'unifi'->>'api_token', ''),
  (l.settings->'unifi') - 'api_token',
  'connected',
  true
FROM public.locations l
WHERE jsonb_typeof(l.settings->'unifi') = 'object'
  AND l.settings->'unifi' <> '{}'::jsonb
  AND NOT EXISTS (
    SELECT 1 FROM public.channel_connections cc
    WHERE cc.location_id = l.id AND cc.platform = 'unifi' AND cc.is_active
  );

-- ── sensibo ─────────────────────────────────────────────────────────
INSERT INTO public.channel_connections
  (location_id, platform, access_token, config, status, is_active)
SELECT
  l.id,
  'sensibo',
  l.sensibo_api_key,
  jsonb_strip_nulls(jsonb_build_object('pod_id', l.sensibo_pod_id)),
  'connected',
  true
FROM public.locations l
WHERE COALESCE(l.sensibo_api_key, '') <> ''
  AND NOT EXISTS (
    SELECT 1 FROM public.channel_connections cc
    WHERE cc.location_id = l.id AND cc.platform = 'sensibo' AND cc.is_active
  );

-- ── thinq ───────────────────────────────────────────────────────────
INSERT INTO public.channel_connections
  (location_id, platform, access_token, config, status, is_active)
SELECT
  l.id,
  'thinq',
  NULLIF(l.thinq_pat, ''),
  jsonb_strip_nulls(jsonb_build_object(
    'client_id', l.thinq_client_id,
    'country_code', l.thinq_country_code
  )),
  'connected',
  true
FROM public.locations l
WHERE (COALESCE(l.thinq_pat, '') <> '' OR COALESCE(l.thinq_client_id, '') <> '')
  AND NOT EXISTS (
    SELECT 1 FROM public.channel_connections cc
    WHERE cc.location_id = l.id AND cc.platform = 'thinq' AND cc.is_active
  );

-- ── twilio_sender ───────────────────────────────────────────────────
INSERT INTO public.channel_connections
  (location_id, platform, config, status, is_active)
SELECT
  l.id,
  'twilio_sender',
  jsonb_build_object('sender_id', l.twilio_alpha_sender_id),
  'connected',
  true
FROM public.locations l
WHERE COALESCE(l.twilio_alpha_sender_id, '') <> ''
  AND NOT EXISTS (
    SELECT 1 FROM public.channel_connections cc
    WHERE cc.location_id = l.id AND cc.platform = 'twilio_sender' AND cc.is_active
  );

-- ── bca ─────────────────────────────────────────────────────────────
-- The features.bca_submit on/off flag stays on locations (it gates the
-- feature, not the connection) — only the config object is registered.
INSERT INTO public.channel_connections
  (location_id, platform, config, status, is_active)
SELECT
  l.id,
  'bca',
  l.bca_config,
  'connected',
  true
FROM public.locations l
WHERE jsonb_typeof(l.bca_config) = 'object'
  AND l.bca_config <> '{}'::jsonb
  AND NOT EXISTS (
    SELECT 1 FROM public.channel_connections cc
    WHERE cc.location_id = l.id AND cc.platform = 'bca' AND cc.is_active
  );

-- ── INTEG-A3 heartbeat seed (repo record; already applied live) ─────
INSERT INTO public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes)
VALUES ('connection-health', 86400, 21600, 'INTEG-A3 daily connection-registry expiry sweep')
ON CONFLICT (name) DO NOTHING;
