-- 329 — WhatsApp number health (Meta quality rating + messaging tier + name status)
-- and the refresh-whatsapp-health cron registration.
--
-- The refresh-whatsapp-health cron (every 30 min) fetches each active number's
-- GET /{phone_number_id}?fields=quality_rating,messaging_limit_tier,name_status from
-- the Graph API and stores it here, so the /communications dashboard renders the
-- number's health without an external API call on every load. It also pushes an
-- alert to owners/managers when the quality rating drops (or the tier is lowered).

ALTER TABLE whatsapp_numbers
  ADD COLUMN IF NOT EXISTS quality_rating text,
  ADD COLUMN IF NOT EXISTS messaging_limit_tier text,
  ADD COLUMN IF NOT EXISTS name_status text,
  ADD COLUMN IF NOT EXISTS quality_checked_at timestamptz;

COMMENT ON COLUMN whatsapp_numbers.quality_rating IS
  'Meta phone-number quality rating (GREEN/YELLOW/RED/UNKNOWN). Trigger-free; refreshed by the refresh-whatsapp-health cron (mig 329). NULL = not yet checked or token lacks scope.';
COMMENT ON COLUMN whatsapp_numbers.messaging_limit_tier IS
  'Meta messaging limit tier — business-initiated conversations / 24h (TIER_250/1K/10K/100K/UNLIMITED).';

INSERT INTO public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes)
VALUES (
  'refresh-whatsapp-health',
  1800,
  900,
  'Every 30 min — fetch each active WhatsApp number''s Meta quality rating + messaging tier, store on whatsapp_numbers, alert owners/managers on a downgrade.'
)
ON CONFLICT (name) DO NOTHING;
