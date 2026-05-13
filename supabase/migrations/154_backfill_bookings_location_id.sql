-- ============================================================
-- 154: BOOKING.1 — backfill bookings.location_id from event_types.location_id
-- ============================================================
--
-- The /api/public/book/route.js insert was missing `location_id`,
-- so every booking created since the bookings table was added has
-- a NULL location_id even though their event_type does have one.
--
-- This broke /bookings (location-scoped) — operators couldn't see
-- bookings made through the public booking page. Operator hit this
-- on 2026-05-13 when Sarah Pearson booked a Free UN1T Consultation
-- and her row didn't show on the bookings tab.
--
-- The code fix lives in src/app/api/public/book/route.js (BOOKING.1
-- commit). This migration backfills existing rows so the operator
-- doesn't have to wait for new bookings.

UPDATE bookings b
SET location_id = et.location_id
FROM event_types et
WHERE b.event_type_id = et.id
  AND b.location_id IS NULL
  AND et.location_id IS NOT NULL;

-- For audit: report how many rows were touched. Run after the
-- UPDATE so the count reflects what we just changed.
DO $$
DECLARE
  total INT;
  still_null INT;
BEGIN
  SELECT COUNT(*) INTO total FROM bookings WHERE location_id IS NOT NULL;
  SELECT COUNT(*) INTO still_null FROM bookings WHERE location_id IS NULL;
  RAISE NOTICE 'BOOKING.1 backfill: % bookings now have location_id, % still NULL', total, still_null;
END $$;
