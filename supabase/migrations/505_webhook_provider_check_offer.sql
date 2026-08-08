-- OFFERS.5 — extend webhook_events provider CHECK with 'revolut_offer'
-- (the new offer-payments webhook), and repair a latent gap while here:
-- 'revolut_class_booking' (PAID-INTRO.6) and 'instagram' exist in
-- WEBHOOK_PROVIDERS but were never added to the DB constraint, so those
-- dedupe inserts have been failing check 23514 (not 23505) and
-- recordWebhookEvent returned { seen: false, error } every time — the
-- webhook-level dedupe layer for both routes was silently inert (their
-- per-feature idempotency guards are what actually held). Verified against
-- the live constraint 2026-08-08.

ALTER TABLE public.webhook_events DROP CONSTRAINT IF EXISTS webhook_events_provider_check;
ALTER TABLE public.webhook_events ADD CONSTRAINT webhook_events_provider_check
  CHECK (provider IN (
    'postmark',
    'revolut',
    'revolut_race',
    'revolut_class_booking',
    'revolut_offer',
    'whatsapp',
    'instagram',
    'twilio',
    'xero',
    'unifi_access',
    'unifi_protect'
  ));
