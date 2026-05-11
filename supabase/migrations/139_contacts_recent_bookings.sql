-- GLOFOX2.1.18 — store recent booking history on contact for the
-- contact-page "Recent classes" view.
--
-- We already fetch the member's bookings during sync to compute
-- the engagement aggregates (mig 137). Storing the raw last-N
-- bookings as JSONB lets the contact page render a class history
-- timeline without making a Glofox API call per page-view.
--
-- Shape: array of trimmed Booking objects (we drop fields the UI
-- doesn't need to keep the column small):
--   [{
--     glofox_id, event_name, model_name, model, time_start,
--     created, status, attended, duration
--   }, ...]
--
-- Capped at 10 items in glofox-sync.js to bound row size.
-- Sorted by time_start descending (most recent class first).

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS recent_bookings JSONB;
