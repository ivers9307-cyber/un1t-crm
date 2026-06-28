-- 327 — retroactively flag contacts whose WhatsApp number has REPEATEDLY hard-
-- failed as undeliverable (not a WhatsApp account), so future broadcasts skip them.
--
-- Pairs with the WA-UNDELIVERABLE change: going forward, repeated permanent-looking
-- send failures set contacts.wa_status='undeliverable' and applyWhatsAppReachability
-- excludes it. This migration applies the same flag to failures that already
-- happened.
--
-- IMPORTANT — threshold of 2: Meta's "Message undeliverable" / code 131026 is an
-- OVERLOADED error (it also fires for transient frequency-capping / throttling), so
-- a SINGLE failure is not proof a number is dead. We only flag a contact with >= 2
-- undeliverable failures (standard hard-bounce suppression) — a genuinely-dead
-- number fails every send; a transiently-throttled one recovers and never reaches 2.
-- Keep this threshold in sync with UNDELIVERABLE_FAILURE_THRESHOLD in src/lib/whatsapp.js.
--
-- Only flips an 'active' contact (never overrides an explicit opted_out/blocked).
-- Reversible: an inbound WhatsApp message reactivates the contact (webhook).

UPDATE contacts c
SET wa_status = 'undeliverable'
WHERE c.wa_status = 'active'
  AND (
    SELECT count(*) FROM whatsapp_broadcast_recipients r
    WHERE r.contact_id = c.id
      AND r.status = 'failed'
      AND r.error_message ~* 'undeliverable'
  ) >= 2;

-- Refresh the column doc to list the new value.
COMMENT ON COLUMN contacts.wa_status IS
  'WhatsApp reachability/consent status: active | opted_out (replied STOP) | blocked (Meta-blocked) | undeliverable (repeatedly failed as not a WhatsApp number; reversible on inbound). Broadcasts only send to active.';
