-- 854 — OFFERTRACK.1: an offer purchase keeps the ad attribution its checkout
-- arrived with, as a /trial purchase does (trial_purchases.attribution).
--
-- Pack and membership sales on /offers sent Meta nothing and stored no ad
-- source, so a campaign driving them could not be measured or optimised. The
-- checkout now stores the UTMs, the click id (as fbc), the browser id (fbp),
-- the Lead's event id, the page and whether it was an in-app browser, plus the
-- buyer's IP address and user agent until the Purchase is sent (removed then;
-- src/lib/offer-purchase-conversion.js). offer_purchases is service role only
-- (mig 827), so no grant is needed and none is given.

ALTER TABLE public.offer_purchases ADD COLUMN IF NOT EXISTS attribution jsonb;

COMMENT ON COLUMN public.offer_purchases.attribution IS
  'OFFERTRACK.1 (mig 854): the checkout''s ad attribution (utm_*, fbc, fbp, lead_event_id, event_source_url, in_app_browser) and, until the Purchase is sent, client_ip and client_user_agent. Never returned by a public route.';
