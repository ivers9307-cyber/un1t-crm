-- 289: HR-CLASS-ALLOC.2 — anonymous (walk-in) HR sessions. An unregistered
-- strap broadcasting during a live class now creates a session with no contact,
-- labelled by its device id on the board. contact_id goes nullable; the
-- customer-self RLS policy keys on contact_id = private.auth_contact_id() so a
-- null-contact row never matches a customer — anonymous sessions stay staff-only.
ALTER TABLE public.heart_rate_sessions ALTER COLUMN contact_id DROP NOT NULL;

COMMENT ON COLUMN public.heart_rate_sessions.contact_id IS
  'Nullable since HR-CLASS-ALLOC.2 (mig 289): NULL = anonymous walk-in session (unregistered strap during a live class), labelled by device_identifier on the board.';
