-- 393 — WhatsApp number protection completion: token-death alerting stamp
-- (WA-TOKEN.1, comms audit 2026-07-10 missing-features batch).
--
-- token_invalid_at: stamped by the refresh-whatsapp-health cron when Meta
-- rejects the number's access token (error code 190 / OAuthException) and
-- cleared by the first successful health fetch. Manager pushes are gated on
-- the TRANSITION into/out of the invalid state (mirroring the WA-QUALITY.1
-- idempotency style), so a dead token pages ONCE, not every 30-min poll tick.
--
-- The send-budget half of this batch (tier headroom gates on blasts + drips)
-- needs no DDL: it reads the existing whatsapp_numbers.messaging_limit_tier
-- (mig 329) and counts usage from whatsapp_messages.

ALTER TABLE whatsapp_numbers
  ADD COLUMN IF NOT EXISTS token_invalid_at timestamptz;

COMMENT ON COLUMN whatsapp_numbers.token_invalid_at IS
  'Set when the health poll classifies a Meta auth failure (error 190 / OAuthException) for this number''s access token; cleared on the next successful health fetch. Alert pushes key off the transition. Mig 393.';
