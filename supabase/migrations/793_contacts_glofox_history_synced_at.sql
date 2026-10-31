-- 793 — ATTHISTORY.1: the one-time full Glofox booking-history read, per contact.
--
--   APPLY BEFORE THE CODE DEPLOYS (the cron selects and stamps this column).
--
-- WHY
-- ───
-- "Has this person ever attended a class here?" is the split every Stillorgan
-- marketing segment rests on (been in → win-back; never been in → trial nurture),
-- and the CRM could not answer it. Every Glofox booking read is a 30-day window
-- (fetchUserBookingsResult, windowDays 30): the nightly glofox-attendance-refresh
-- re-reads paying members and the last 35 days of prospects, and class_bookings
-- starts in June 2026. On 31 Oct 2026 only 658 of 8,851 Stillorgan contacts
-- carried last_attended_at at all, and former members whose last class predates
-- the CRM (April 2026) looked exactly like a lead who never came in. Mig 595
-- parked the returning board for the same reason.
--
-- WHAT
-- ────
-- /api/cron/glofox-attendance-history (vercel.json */10) reads the FULL booking
-- history (/2.0/bookings, a ten-year time_start, every page) ONCE for every
-- Glofox-linked contact at a Glofox studio, and advances last_attended_at /
-- last_booked_at the advance-only way (mergeBookingAggregates: a stored date is
-- never regressed, the 7-/30-day counts are left to the refresh). This column
-- is its cursor: NULL = never read; a read, a refusal or a failure all stamp it
-- (DETAILBACKFILL.1: a cursor advances on every attempt, or the queue pins),
-- and the run's glofox_sync_runs row lists the contacts whose read failed so
-- an operator can NULL them back for a second pass. A contact linked to Glofox
-- later is read on the next tick, so the fact stays complete.
--
-- Once stamped, `last_attended_at IS NULL` means "never attended a class here
-- as far as Glofox knows", and the audience builder's existing
-- last_attended_at is_null / is_not_null ops become the segment split.
--
-- Privileges: contacts has table-level SELECT for authenticated (and nothing
-- for anon), so the new column is readable like every other and needs no
-- grant. It is sync bookkeeping, excluded from contact_location_audience in
-- tests/audience-view-columns-guard.test.js (mig 726's un1t_synced_at shape).
-- studio_contacts (mig 765) was created with c.* and does not pick it up;
-- nothing reads it there.

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS glofox_history_synced_at timestamptz;

COMMENT ON COLUMN public.contacts.glofox_history_synced_at IS
  'ATTHISTORY.1 (mig 793): when /api/cron/glofox-attendance-history last read this contact''s full Glofox booking history (the cursor of a one-time-per-contact read; stamped on every attempt, success or not). NULL = not yet read. After it, last_attended_at IS NULL means Glofox holds no attended class for this member.';

-- The cron's candidate read: Glofox-linked contacts at a studio, not yet read,
-- oldest first. Partial, so it shrinks to nothing as the sweep completes and
-- costs the table almost nothing afterwards.
CREATE INDEX IF NOT EXISTS idx_contacts_glofox_history_pending
  ON public.contacts (location_id, created_at, id)
  WHERE glofox_history_synced_at IS NULL AND glofox_member_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'contacts' AND column_name = 'glofox_history_synced_at'
  ) THEN
    RAISE EXCEPTION 'mig 793: contacts.glofox_history_synced_at was not added';
  END IF;
END $$;
