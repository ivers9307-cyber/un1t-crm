-- 399: Cross-channel marketing frequency cap (FREQ-CAP.1)
--
-- COMMS-AUDIT 2026-07-10 missing-features item: nothing stops one
-- contact getting an email campaign + a WhatsApp broadcast + a
-- sequence step on the same day. This migration adds the single
-- piece of DB state the cap needs: a per-contact "last marketing
-- touch" stamp. Every successful MARKETING send (email broadcast
-- campaigns, WA blasts/drips, sequence email + WhatsApp steps)
-- stamps it — regardless of whether the cap is enabled, so turning
-- the cap on later starts with real history. Transactional /
-- administrative sends (booking confirmations, reminders, inbox 1:1,
-- Mia) NEVER stamp it.
--
-- The cap setting itself is JSONB (no DDL):
--   locations.settings.comms_frequency_cap =
--     { "enabled": false, "min_hours_between": 24 }
-- OFF by default — enabling it silently would block sends operators
-- expect. Enforcement lives in code (src/lib/frequency-cap.js).
--
-- New campaign_recipients status used by code: 'skipped_frequency_cap'
-- (safety valve — a recipient still cap-deferred 7 days after the
-- campaign started sending is skipped so the campaign can finalise).
-- status is free TEXT with no CHECK constraint (see mig 392's note for
-- the same pattern with 'failed'), and campaign stats are computed
-- from email_sends (recalculate_campaign_stats, mig 157), so the new
-- status needs no DDL and cannot corrupt counters.
--
-- No index on last_marketing_touch_at: every enforcement gate reaches
-- the column either through the contacts PK (the campaign chunk query
-- embeds contacts!inner by contact_id) or in memory on rows already
-- fetched for the send (WA blast/drip audiences, sequence contacts).
-- Nothing scans contacts BY this column.

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS last_marketing_touch_at timestamptz;

COMMENT ON COLUMN contacts.last_marketing_touch_at IS
  'Last successful MARKETING send to this contact across channels (email campaign, WA blast/drip, sequence email/WA step) — FREQ-CAP.1, mig 399. Stamped on every marketing send even when the cap is disabled; never stamped by transactional/administrative sends. Drives locations.settings.comms_frequency_cap enforcement.';
