-- Retire the Google Business Profile API integration.
--
-- The reviews carousel stays (the `google_reviews` table + the `reviews`
-- landing-page block), but reviews are now populated MANUALLY — the OAuth
-- connect flow, the review sync, and the daily cron were removed in code
-- (they were gated behind Google's API access approval, not worth it for our
-- volume). This migration removes the DB remnants:
--   - the per-location connection table (held OAuth tokens; always empty here)
--     + its refresh-timestamp trigger function
--   - the cron heartbeat row, so the health-check / Sentinel don't flag the
--     now-deleted `sync-google-reviews` cron as permanently stale.
--
-- `google_reviews` is intentionally left untouched — it holds the live review
-- data the carousel renders.

DROP TABLE IF EXISTS google_business_connections CASCADE;  -- drops its trigger too
DROP FUNCTION IF EXISTS private.bump_gbc_refresh_ts();

DELETE FROM cron_heartbeats WHERE name = 'sync-google-reviews';
