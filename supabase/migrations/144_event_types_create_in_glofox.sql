-- GLOFOX3.2 — opt-in flag on booking types: when true, every public
-- booking on this event_type triggers a CRM → Glofox push of the
-- booking customer (createIfMissing=true, attachTrial=true).
--
-- Default false: the CRM ships safe — only the operator-elected
-- booking types push to Glofox. Existing rows aren't touched.
--
-- The push itself runs from /api/public/book/route.js after the
-- DB trigger creates the contact (handle_new_booking). Best-effort,
-- fire-and-forget; failures land in glofox_push_events for the
-- Review tab (mig 143).

ALTER TABLE event_types
  ADD COLUMN IF NOT EXISTS create_in_glofox BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN event_types.create_in_glofox IS
  'GLOFOX3.2: when true, public bookings against this event type push the booking contact to Glofox (search-and-link OR create + attach trial + welcome sequence).';
