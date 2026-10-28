-- 786 — UN1TMOVE.1: the un1t.online booking move ledger op.
--
-- WHY. Rescheduling a Hatch Street (un1t.online) class booking used to be a
-- cancel then a new booking: two writes, and a window in which the credit or
-- the spot is lost (the cancel lands, the book is refused because the class
-- filled or the credit has not come back yet). un1t.online moves a booking in
-- ONE call, POST /bookings/{id}/move { eventId } (x-permission
-- bookings:update). The CRM's moveBooking primitive sends it, and every write
-- attempt is a un1t_write_events row, so the ledger gains the op 'move'.
--
-- WHAT.
--   (1) un1t_write_events_op_check admits 'move' (every op mig 781 allowed is
--       kept: create_client, forgot_password, trial, book, cancel, checkout,
--       trial_regrant, fee_charge).
--   (2) un1t_write_events.late_window boolean NOT NULL DEFAULT false
--       (UN1TMOVE.2, Richard 28 Oct 2026): true on a move made while leaving
--       the class fell inside the studio's late-cancel window. A booking moved
--       that way can never be cancelled by the CRM afterwards (move to a later
--       class the same day, then cancel, is how a late-cancel fee would be
--       dodged), and every CRM cancel path reads this flag first. CHECK: only
--       a move row carries it.
--   A move row names the booking it moves in `target` (as a cancel row does)
--   and its target class in its key (move:<loc>:<booking>:<event>); once done
--   its un1t_ref is the booking id un1t.online answered with. The one-open
--   index (one attempt in flight or in doubt per key) already holds it. No one-done index: a booking can be moved back and forth, so a done
--   move is confirmed by the check read before it is trusted (in code).
--   The origin CHECK (mig 781) is unchanged: staff, approval and mia moves use
--   origins it already admits.
--
-- GRANTS. No privilege changes: un1t_write_events stays service_role only
-- (mig 744: RLS on, no policy, nothing for anon/authenticated).
--   grant: n/a, no new table, view, sequence or function; the new column is
--   on a table no client role holds any privilege on.
--
-- LOCKS. One transaction, 5s lock_timeout. The CHECK swap scans the ledger
-- (small: a few hundred rows).
--
-- IDEMPOTENT. Drop-if-exists then add. The DO block checks the POST-STATE in
-- the catalog and aborts the whole file.
--
-- ORDER. Apply BEFORE the code that writes op 'move' deploys: until then the
-- CHECK refuses the row (and the late_window column it inserts is missing),
-- so a move fails closed (the ledger insert errors before anything is sent,
-- nothing reaches un1t.online). The cancel paths read late_window too: until
-- it exists their read errors and every cancel refuses (fail closed), so this
-- must be applied first.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.un1t_write_events
  DROP CONSTRAINT IF EXISTS un1t_write_events_op_check;
ALTER TABLE public.un1t_write_events
  ADD CONSTRAINT un1t_write_events_op_check
  CHECK (op IN ('create_client', 'forgot_password', 'trial', 'book', 'cancel', 'checkout', 'trial_regrant', 'fee_charge', 'move'));

ALTER TABLE public.un1t_write_events
  ADD COLUMN IF NOT EXISTS late_window boolean NOT NULL DEFAULT false;
ALTER TABLE public.un1t_write_events
  DROP CONSTRAINT IF EXISTS un1t_write_events_late_window_check;
ALTER TABLE public.un1t_write_events
  ADD CONSTRAINT un1t_write_events_late_window_check
  CHECK (late_window = false OR op = 'move');

-- The cancel paths' read: late-window moves of one booking, by target or answer.
CREATE INDEX IF NOT EXISTS un1t_write_events_late_moves
  ON public.un1t_write_events (location_id, target)
  WHERE op = 'move' AND late_window;

COMMENT ON COLUMN public.un1t_write_events.late_window IS
  'UN1TMOVE.2 (mig 786): true on a move made inside the studio''s late-cancel window (allowed only to a class the same studio day). Such a booking is never cancelled by the CRM afterwards: every un1t.online cancel path (the cancel primitive, Mia, the staff route, the approval executor) reads this first and refuses, failing closed when it cannot read it.';

COMMENT ON TABLE public.un1t_write_events IS
  'UN1TWRITE.1 (mig 744): one row per un1t.online write attempt (book, cancel, create_client, forgot_password, trial, checkout; trial_regrant since mig 760; fee_charge since mig 781; move since mig 786). The write-ahead marker, the resume point for retries and approvals, the dedupe of the CRM''s own attempts and the audit trail. Keys: create:<loc>:<contact>, trial:<loc>:<un1tUser>:<product>:<method>, trial_regrant:<loc>:<un1tUser>, book:<loc>:<un1tUser>:<event>, cancel:<loc>:<booking>, move:<loc>:<booking>:<event> (late_window since mig 786), fee:<loc>:<fee>:<n>, pw:<loc>:<un1tUser>:<n>, checkout = the caller''s key (also the idempotency-key header on purchase and credit-grant calls). message is <= 500 chars and never carries a password, token, email or phone. Service role only.';

-- ---------------------------------------------------------------------------
-- Self-check: the post-state in the catalog, never this file's text.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  d text;
  k text;
BEGIN
  d := pg_get_constraintdef((SELECT oid FROM pg_constraint
        WHERE conrelid = 'public.un1t_write_events'::regclass AND conname = 'un1t_write_events_op_check'));
  IF d IS NULL THEN
    RAISE EXCEPTION 'mig 786: un1t_write_events_op_check missing';
  END IF;
  FOREACH k IN ARRAY ARRAY['create_client', 'forgot_password', 'trial', 'book', 'cancel', 'checkout', 'trial_regrant', 'fee_charge', 'move'] LOOP
    IF d NOT LIKE '%''' || k || '''%' THEN
      RAISE EXCEPTION 'mig 786: un1t_write_events_op_check does not admit %: %', k, d;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'un1t_write_events'
                   AND column_name = 'late_window' AND is_nullable = 'NO' AND data_type = 'boolean') THEN
    RAISE EXCEPTION 'mig 786: un1t_write_events.late_window missing or wrong';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.un1t_write_events'::regclass AND conname = 'un1t_write_events_late_window_check') THEN
    RAISE EXCEPTION 'mig 786: un1t_write_events_late_window_check missing';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.table_privileges
             WHERE table_schema = 'public' AND table_name = 'un1t_write_events'
               AND grantee IN ('anon', 'authenticated', 'PUBLIC')) THEN
    RAISE EXCEPTION 'mig 786: a client role holds a privilege on un1t_write_events';
  END IF;
END;
$$;

COMMIT;
