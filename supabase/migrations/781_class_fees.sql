-- 781 — FEES.1: late-cancellation and no-show fees at un1t.online studios.
--
-- WHY. Richard, 28 Oct 2026: at a un1t.online studio (Hatch Street) the CRM
-- lists each day's no-shows and late cancellations at 23:00 studio time,
-- emails the review contacts a link, lets staff waive any fee, and at 17:00
-- the next day charges every fee not waived to the member's default card in
-- un1t.online ("Charge custom amount", POST /purchases/charge-custom, with the
-- class, day and time as the description). A refused charge is tried once
-- more 7 days later, then it is an OUTSTANDING balance on the member's
-- profile with a Retry charge button. A pack member who cancels inside
-- un1t.online's own window already loses the credit (un1t.online keeps it,
-- confirmed 28 Oct), so that is only recorded.
--
-- WHAT.
--   (1) un1t_bookings.cancelled_at: when the booking was cancelled, frozen
--       the first time the mirror sees status 'cancelled' (un1t.online's own
--       updated_at at that moment; the API has no cancel timestamp). A trigger
--       keeps it, so no sync code can forget: an upsert that does not name the
--       column carries the stored value forward, and a booking that leaves
--       'cancelled' clears it. Existing cancelled rows are backfilled from
--       remote_updated_at.
--   (2) class_fees: one row per offence (location, un1t booking). Service role
--       only: RLS on, no policy, nothing for anon/authenticated (the review
--       page and the contact card read it through /api/class-fees*).
--   (3) un1t_write_events admits op 'fee_charge' and origin 'fee_run' (the
--       nightly charge). Every op and origin allowed before is kept. A
--       fee_charge row names its un1t user and its fee (target = class_fees.id).
--   (4) A cron_heartbeats row for the hourly class-fees cron.
--
-- GRANTS.
--   class_fees: REVOKE ALL FROM anon, authenticated (service role only).
--   public.class_fees_touch / public.un1t_bookings_stamp_cancelled_at:
--   trigger functions, REVOKE EXECUTE FROM PUBLIC, anon, authenticated.
--   -- column-grant: n/a, un1t_bookings has no client privilege (mig 726).
--
-- LOCKS. One transaction, 5s lock_timeout. un1t_bookings is small (hundreds
-- of rows); the ledger CHECK swaps scan a few hundred rows.
--
-- ORDER. Apply BEFORE the FEES.1 code deploys: until then the ledger CHECKs
-- refuse a fee_charge row and the charge fails closed before anything is
-- sent. The heartbeat row is born healthy; if the deploy lands more than
-- ~3 hours after this file, re-run its INSERT after the deploy.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- (1) un1t_bookings.cancelled_at
-- ---------------------------------------------------------------------------
ALTER TABLE public.un1t_bookings ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;

COMMENT ON COLUMN public.un1t_bookings.cancelled_at IS
  'FEES.1 (mig 781): when the booking was cancelled, frozen the first time the mirror saw status cancelled (un1t.online updated_at at that moment; the API has no cancel time). Kept by trigger un1t_bookings_stamp_cancelled_at; NULL when not cancelled.';

CREATE OR REPLACE FUNCTION public.un1t_bookings_stamp_cancelled_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF lower(coalesce(NEW.status, '')) IN ('cancelled', 'canceled') THEN
    IF TG_OP = 'UPDATE' AND OLD.cancelled_at IS NOT NULL
       AND lower(coalesce(OLD.status, '')) IN ('cancelled', 'canceled') THEN
      NEW.cancelled_at := OLD.cancelled_at;
    ELSIF NEW.cancelled_at IS NULL THEN
      NEW.cancelled_at := coalesce(NEW.remote_updated_at, now());
    END IF;
  ELSE
    NEW.cancelled_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.un1t_bookings_stamp_cancelled_at() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS un1t_bookings_stamp_cancelled_at ON public.un1t_bookings;
CREATE TRIGGER un1t_bookings_stamp_cancelled_at
  BEFORE INSERT OR UPDATE ON public.un1t_bookings
  FOR EACH ROW EXECUTE FUNCTION public.un1t_bookings_stamp_cancelled_at();

UPDATE public.un1t_bookings
   SET cancelled_at = coalesce(remote_updated_at, synced_at)
 WHERE lower(coalesce(status, '')) IN ('cancelled', 'canceled')
   AND cancelled_at IS NULL;

-- ---------------------------------------------------------------------------
-- (2) class_fees
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.class_fees (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id          uuid        NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  contact_id           uuid        REFERENCES public.contacts(id) ON DELETE SET NULL,
  un1t_user_id         text        NOT NULL,
  un1t_booking_id      text        NOT NULL,
  un1t_event_id        text        NOT NULL,
  class_title          text,
  starts_at            timestamptz NOT NULL,
  class_day            date        NOT NULL,
  kind                 text        NOT NULL CONSTRAINT class_fees_kind_check
                         CHECK (kind IN ('late_cancel', 'no_show')),
  cancelled_at         timestamptz,
  minutes_before_start integer,
  penalty              text        NOT NULL CONSTRAINT class_fees_penalty_check
                         CHECK (penalty IN ('fee', 'credit_forfeit')),
  amount_cents         integer     NOT NULL DEFAULT 0 CONSTRAINT class_fees_amount_check
                         CHECK (amount_cents >= 0 AND amount_cents <= 100000),
  currency             text        NOT NULL DEFAULT 'eur',
  charge_description   text        CONSTRAINT class_fees_description_length_check
                         CHECK (char_length(charge_description) <= 200),
  status               text        NOT NULL CONSTRAINT class_fees_status_check
                         CHECK (status IN ('pending', 'waived', 'charging', 'charged', 'retry_scheduled', 'outstanding', 'recorded')),
  attempts             integer     NOT NULL DEFAULT 0 CONSTRAINT class_fees_attempts_check CHECK (attempts >= 0),
  charge_due_at        timestamptz,
  next_attempt_at      timestamptz,
  charge_started_at    timestamptz,
  charged_at           timestamptz,
  un1t_transaction_id  text,
  failure_code         text,
  failure_message      text        CONSTRAINT class_fees_failure_message_length_check
                         CHECK (char_length(failure_message) <= 500),
  waived_by            uuid,
  waived_reason        text        CONSTRAINT class_fees_waived_reason_length_check
                         CHECK (char_length(waived_reason) <= 500),
  waived_at            timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT class_fees_booking_unique UNIQUE (location_id, un1t_booking_id),
  -- A fee carries money and a description; a credit forfeit carries neither
  -- and is only ever recorded.
  CONSTRAINT class_fees_penalty_shape_check CHECK (
    (penalty = 'fee' AND amount_cents > 0 AND charge_description IS NOT NULL AND status <> 'recorded')
    OR (penalty = 'credit_forfeit' AND amount_cents = 0 AND status = 'recorded')
  ),
  CONSTRAINT class_fees_waived_shape_check CHECK ((status = 'waived') = (waived_at IS NOT NULL)),
  CONSTRAINT class_fees_charged_shape_check CHECK ((status = 'charged') = (un1t_transaction_id IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS class_fees_transaction_unique
  ON public.class_fees (location_id, un1t_transaction_id)
  WHERE un1t_transaction_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS class_fees_due
  ON public.class_fees (location_id, status, charge_due_at);

CREATE INDEX IF NOT EXISTS class_fees_retry_due
  ON public.class_fees (location_id, next_attempt_at)
  WHERE status = 'retry_scheduled';

CREATE INDEX IF NOT EXISTS class_fees_contact_open
  ON public.class_fees (location_id, contact_id)
  WHERE status IN ('pending', 'charging', 'retry_scheduled', 'outstanding');

CREATE INDEX IF NOT EXISTS class_fees_day
  ON public.class_fees (location_id, class_day DESC);

ALTER TABLE public.class_fees ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.class_fees FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.class_fees_touch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.class_fees_touch() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS class_fees_touch ON public.class_fees;
CREATE TRIGGER class_fees_touch
  BEFORE UPDATE ON public.class_fees
  FOR EACH ROW EXECUTE FUNCTION public.class_fees_touch();

COMMENT ON TABLE public.class_fees IS
  'FEES.1 (mig 781): one row per late cancellation or no-show at a un1t.online studio. fee rows are charged by the class-fees cron through un1t.online charge-custom (pending -> charging -> charged | retry_scheduled -> outstanding, or waived by staff); credit_forfeit rows (a pack member inside un1t.online''s window) are only recorded. Service role only.';

-- ---------------------------------------------------------------------------
-- (3) The un1t.online write ledger
-- ---------------------------------------------------------------------------
ALTER TABLE public.un1t_write_events
  DROP CONSTRAINT IF EXISTS un1t_write_events_op_check;
ALTER TABLE public.un1t_write_events
  ADD CONSTRAINT un1t_write_events_op_check
  CHECK (op IN ('create_client', 'forgot_password', 'trial', 'book', 'cancel', 'checkout', 'trial_regrant', 'fee_charge'));

ALTER TABLE public.un1t_write_events
  DROP CONSTRAINT IF EXISTS un1t_write_events_origin_check;
ALTER TABLE public.un1t_write_events
  ADD CONSTRAINT un1t_write_events_origin_check
  CHECK (origin IN ('staff', 'funnel', 'approval', 'mia', 'test_account', 'web_trial', 'fee_run'));

ALTER TABLE public.un1t_write_events
  DROP CONSTRAINT IF EXISTS un1t_write_events_fee_target_check;
ALTER TABLE public.un1t_write_events
  ADD CONSTRAINT un1t_write_events_fee_target_check
  CHECK (op <> 'fee_charge' OR (un1t_user_id IS NOT NULL AND target IS NOT NULL));

-- ---------------------------------------------------------------------------
-- (4) Heartbeat: the cron runs hourly. Grace 3600 s: one missed tick
-- (3600 + jitter + run time) never pages; two do.
-- ---------------------------------------------------------------------------
INSERT INTO public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, last_ok_at, notes)
VALUES (
  'class-fees',
  3600,
  3600,
  now(),
  'FEES.1: hourly; lists late cancels and no-shows at 23:00 and charges fees at 17:00, each studio on its own clock'
)
ON CONFLICT (name) DO UPDATE
  SET last_ok_at = now(),
      expected_interval_seconds = excluded.expected_interval_seconds,
      grace_seconds = excluded.grace_seconds,
      notes = excluded.notes;

-- ---------------------------------------------------------------------------
-- Self-check: the post-state in the catalog, never this file's text.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  d text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'un1t_bookings' AND column_name = 'cancelled_at') THEN
    RAISE EXCEPTION 'mig 781: un1t_bookings.cancelled_at missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'un1t_bookings_stamp_cancelled_at'
                 AND tgrelid = 'public.un1t_bookings'::regclass) THEN
    RAISE EXCEPTION 'mig 781: un1t_bookings_stamp_cancelled_at trigger missing';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.class_fees'::regclass) THEN
    RAISE EXCEPTION 'mig 781: class_fees RLS is off';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.table_privileges
             WHERE table_schema = 'public' AND table_name = 'class_fees'
               AND grantee IN ('anon', 'authenticated', 'PUBLIC')) THEN
    RAISE EXCEPTION 'mig 781: a client role holds a privilege on class_fees';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'class_fees') THEN
    RAISE EXCEPTION 'mig 781: class_fees must have no policy';
  END IF;
  d := pg_get_constraintdef((SELECT oid FROM pg_constraint
        WHERE conrelid = 'public.un1t_write_events'::regclass AND conname = 'un1t_write_events_op_check'));
  IF d IS NULL OR d NOT LIKE '%fee_charge%' OR d NOT LIKE '%trial_regrant%' THEN
    RAISE EXCEPTION 'mig 781: un1t_write_events_op_check does not admit fee_charge';
  END IF;
  d := pg_get_constraintdef((SELECT oid FROM pg_constraint
        WHERE conrelid = 'public.un1t_write_events'::regclass AND conname = 'un1t_write_events_origin_check'));
  IF d IS NULL OR d NOT LIKE '%fee_run%' OR d NOT LIKE '%web_trial%' THEN
    RAISE EXCEPTION 'mig 781: un1t_write_events_origin_check does not admit fee_run';
  END IF;
END;
$$;

COMMIT;
