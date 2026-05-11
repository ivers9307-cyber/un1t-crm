-- GLOFOX2.1.14 — booking aggregate fields on contacts.
--
-- Mirrors the existing email/whatsapp engagement-tracking pattern
-- (last_emailed_at + total_emails_sent from mig 005,
--  last_wa_message_at + total_wa_sent from mig 007).
--
-- Powers engagement-based audiences:
--   "Members who haven't attended in 14 days"
--      → Last Attended (Glofox) — more than 14 days ago
--   "Members with their first attendance"
--      → Last Attended (Glofox) is_not_null
--          AND Total Attended (30d) = 1
--   "High-engagement members"
--      → Total Attended (30d) > 8
--
-- Computed aggregates rather than full booking history. Two
-- update paths:
--   1. Per-member sync (single-member route + daily cron) — fetch
--      bookings via /2.0/bookings?user_id=X&time_start=<30d_ago>,
--      compute aggregates, write to these fields.
--   2. Real-time webhook (BOOKING_CREATED/UPDATED/DELETED, future
--      commit) — increment counters + bump timestamps directly.
--
-- The full-recompute path always wins on conflict (cron is the
-- safety net that corrects any webhook-counter drift).

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_booked_at      TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_attended_at    TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS total_bookings_30d  INT DEFAULT 0;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS total_attended_30d  INT DEFAULT 0;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS total_noshow_30d    INT DEFAULT 0;

-- Indexes for the typical engagement-audience filters.
-- last_attended_at supports "haven't attended in N days" (the
-- core re-engagement signal).
-- total_attended_30d supports "high-engagement member" + "low-
-- engagement member" segmentation.
CREATE INDEX IF NOT EXISTS idx_contacts_last_attended_at  ON contacts (last_attended_at);
CREATE INDEX IF NOT EXISTS idx_contacts_total_attended_30d ON contacts (total_attended_30d);
