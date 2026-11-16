-- 842_bookings_no_overlap.sql
--
-- BOOKONE.1 (15 Nov 2026 feature audit, step 2 item 12): the database refuses
-- two live bookings of one event type that overlap.
--
-- NOT APPLIED YET when this file was written. Safe to apply before or after
-- the BOOKONE.1 code deploys: the code reads the refusal (23P01) as "slot
-- taken", and before the code ships the old routes answer a refused insert
-- with their existing error. Behaviour is proven ahead of apply by
-- tests/migration-842-bookings-no-overlap.test.js (PGlite).
--
-- WHY
-- Every booking path checked "is this slot free" by reading, then inserted.
-- Two people submitting the same slot at the same moment both pass the read
-- and both land, and two of the four paths did not check at all. A
-- constraint is the only check two requests cannot both pass.
--
-- VERIFIED LIVE (16 Nov 2026, read-only): 40 bookings, no row with
-- end_time <= start_time, and 0 overlapping confirmed/completed pairs on one
-- event type, so the constraint adds cleanly. btree_gist 1.7 is installed in
-- schema `extensions` (mig 602 created it).
--
-- WHAT
--   bookings_no_overlap: EXCLUDE USING gist on (event_type_id =, the
--   [start, end) range on booking_date) for rows with status confirmed or
--   completed. A cancelled booking frees its slot. Half-open ranges, so one
--   booking ending at 10:00 and the next starting at 10:00 do not clash.
--   The self-check below refuses to add it over existing overlaps (it names
--   the count) rather than failing on an opaque constraint error.
--
-- ROLLBACK: ALTER TABLE public.bookings DROP CONSTRAINT IF EXISTS bookings_no_overlap;

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $pre$
DECLARE
  v_overlaps integer;
BEGIN
  SELECT count(*) INTO v_overlaps
    FROM public.bookings a
    JOIN public.bookings b
      ON a.id < b.id
     AND a.event_type_id = b.event_type_id
     AND a.booking_date = b.booking_date
     AND a.status IN ('confirmed', 'completed')
     AND b.status IN ('confirmed', 'completed')
     AND a.start_time < b.end_time
     AND b.start_time < a.end_time;
  IF v_overlaps > 0 THEN
    RAISE EXCEPTION '842: % overlapping live booking pair(s) exist; resolve them before adding bookings_no_overlap', v_overlaps;
  END IF;
END
$pre$;

ALTER TABLE public.bookings DROP CONSTRAINT IF EXISTS bookings_no_overlap;
ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_no_overlap
  EXCLUDE USING gist (
    event_type_id WITH =,
    tsrange(booking_date + start_time, booking_date + end_time, '[)') WITH &&
  ) WHERE (status IN ('confirmed', 'completed'));

COMMENT ON CONSTRAINT bookings_no_overlap ON public.bookings IS
  'BOOKONE.1 (mig 842): no two confirmed/completed bookings of one event type overlap. createBooking (src/lib/bookings-write.js) reads its refusal (23P01) as "slot taken".';

COMMIT;
