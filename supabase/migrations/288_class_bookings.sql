-- 288: HR-CLASS-ALLOC.2 — the per-event class booking roster. Glofox exposes
-- no per-event attendee endpoint, so we assemble the roster from the per-member
-- /2.0/bookings fetches we already do (daily glofox-sync + every BOOKING_*
-- webhook via applyMemberSync). Drives (a) the booked-vs-presence tag on
-- heart_rate_sessions and (b) the coach-view live-class roster panel.
CREATE TABLE IF NOT EXISTS public.class_bookings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id       uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  glofox_event_id   text NOT NULL,
  glofox_booking_id text NOT NULL,
  glofox_member_id  text,
  contact_id        uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  member_name       text,
  class_name        text,
  starts_at         timestamptz,
  status            text,
  attended          boolean NOT NULL DEFAULT false,
  raw               jsonb,
  synced_at         timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_id, glofox_booking_id)
);

CREATE INDEX IF NOT EXISTS idx_class_bookings_event
  ON public.class_bookings (location_id, glofox_event_id);
CREATE INDEX IF NOT EXISTS idx_class_bookings_member_event
  ON public.class_bookings (location_id, glofox_member_id, glofox_event_id);
CREATE INDEX IF NOT EXISTS idx_class_bookings_contact
  ON public.class_bookings (contact_id) WHERE contact_id IS NOT NULL;

ALTER TABLE public.class_bookings ENABLE ROW LEVEL SECURITY;

-- Staff at the location can read; writes are service-role only (sync workers).
CREATE POLICY "class_bookings_location_read" ON public.class_bookings
  FOR SELECT TO authenticated
  USING (private.auth_is_in_location(location_id));

COMMENT ON TABLE public.class_bookings IS
  'HR-CLASS-ALLOC.2 (mig 288): per-event Glofox booking roster, assembled from per-member /2.0/bookings fetches. Drives the booked tag + coach roster panel.';
