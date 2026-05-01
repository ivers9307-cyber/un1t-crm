-- Performance audit (May 2026) flagged a handful of missing indexes
-- on hot read paths. Each one is a no-op if it already exists.
--
-- The bookings.location_id index is the headline fix — every server
-- component that lists bookings (the Bookings tab, the per-event page,
-- the events list, and /api/bookings) filters by location_id but the
-- table only has indexes on contact_id, event_type_id, status, date,
-- and email (mig 002). As bookings grew this became a full scan that
-- got worse every week.
--
-- Composite (location_id, booking_date DESC) lets Postgres satisfy
-- the typical query "bookings for this location, most recent first"
-- with an index-only scan.

CREATE INDEX IF NOT EXISTS idx_bookings_location_date
  ON bookings (location_id, booking_date DESC);

-- shifts already has (location_id, shift_date) and (profile_id,
-- shift_date) — leave those alone. Adding nothing new there.

-- whatsapp_messages — the inbox polls /api/whatsapp/conversations/:id
-- which loads messages by conversation_id ordered by created_at.
-- mig 007 has (conversation_id, created_at) ascending which matches
-- our scroll-to-bottom render — already optimal.

-- contacts — frequently filtered by (location_id, lead_status). The
-- single-column idx_contacts_location exists but a partial covering
-- index on the active leads slice cuts the typical pipeline query
-- in half.

CREATE INDEX IF NOT EXISTS idx_contacts_location_lead_status
  ON contacts (location_id, lead_status)
  WHERE lead_status IS NOT NULL;

-- sequence_enrollments — already has idx_enrollments_next_step
-- (partial WHERE status='active') from mig 005, which is exactly what
-- the runner needs. No new index required here.
