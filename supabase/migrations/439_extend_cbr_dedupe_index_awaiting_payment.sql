-- The active-booking uniqueness guarantee must also cover awaiting_payment, so
-- two concurrent PAID submits for the same (contact, class) can't each open a
-- separate provider order (double-charge). The app-level pre-insert dedupe SELECT
-- is not atomic with the INSERT — this partial unique index is the real guarantee.
-- No awaiting_payment rows exist yet, so the recreate is safe.
drop index if exists public.uq_cbr_active_contact_event;
create unique index if not exists uq_cbr_active_contact_event
  on public.class_booking_requests (contact_id, glofox_event_id)
  where status in ('queued','processing','booked','awaiting_payment');
