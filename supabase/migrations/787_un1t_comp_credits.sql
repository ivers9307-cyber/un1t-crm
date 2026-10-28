-- 787 — UN1TCOMP.1: complimentary un1t.online credits on the write ledger.
--
-- WHY. Richard, 28 Oct 2026: staff with the new web permission
-- un1t_comp_credits (owner, manager and reception by default) may add
-- complimentary class credits, with a use-by date, to a member's un1t.online
-- account from the Hatch card on the contact page. The CRM's
-- grantCompCredits primitive sends POST /credits/grant { userId, amount,
-- expiresInDays } (the same endpoint as the trial re-grant, mig 760) as its
-- own op, and every attempt is a un1t_write_events row, so the ledger gains
-- the op 'comp_credits' and the columns that say what was given, why and
-- until when. The card's "Complimentary credits given" list and the audit
-- read them back.
--
-- WHAT.
--   (1) un1t_write_events_op_check admits 'comp_credits' (every op mig 786
--       allowed is kept: create_client, forgot_password, trial, book, cancel,
--       checkout, trial_regrant, fee_charge, move).
--   (2) Six columns, NULL on every other op:
--         comp_amount          smallint     credits given (1 to 10)
--         comp_expires_in_days smallint     the expiresInDays sent (1 to 365)
--         comp_use_by          date         the use-by day staff chose, on
--                                           the studio's clock
--         comp_reason          text         goodwill | injury |
--                                           class_cancelled |
--                                           referral_reward | other
--         comp_note            text         the optional team note, <= 200
--                                           characters (the app refuses an
--                                           email address or phone number)
--         comp_expires_at      timestamptz  the expiry un1t.online answered
--                                           a done grant with
--   (3) un1t_write_events_comp_check: a comp_credits row names its person
--       (un1t_user_id), the member of staff (actor_user_id), origin 'staff',
--       and its amount, days, use-by day and reason within the limits; any
--       other op carries none of the six columns.
--   (4) The "given" list's read: un1t_write_events_comp_given on
--       (location_id, un1t_user_id, created_at DESC) WHERE op = 'comp_credits'.
--   A comp row's key is comp:<loc>:<un1tUser>:<request id> (one per form
--   submission, so a double click is one grant); target is null; once done
--   its un1t_ref is the credit batch id. The one-open index (one attempt in
--   flight or in doubt per key) already holds it. No one-done index: staff
--   may give credits more than once. The origin CHECK (mig 781) already
--   admits 'staff'.
--
-- GRANTS. No privilege changes: un1t_write_events stays service_role only
-- (mig 744: RLS on, no policy, nothing for anon/authenticated).
--   grant: n/a, no new table, view, sequence or function; the new columns are
--   on a table no client role holds any privilege on.
--
-- LOCKS. One transaction, 5s lock_timeout. The CHECK swaps scan the ledger
-- (small: a few hundred rows).
--
-- IDEMPOTENT. ADD COLUMN IF NOT EXISTS, drop-if-exists then add. The DO block
-- checks the POST-STATE in the catalog and aborts the whole file.
--
-- ORDER. Apply BEFORE the code that writes op 'comp_credits' deploys: until
-- then the CHECK refuses the row (and the columns it inserts are missing), so
-- a grant fails closed (the ledger insert errors before anything is sent,
-- nothing reaches un1t.online), and the card's "given" list read errors (the
-- card shows the credits without the list).

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.un1t_write_events
  DROP CONSTRAINT IF EXISTS un1t_write_events_op_check;
ALTER TABLE public.un1t_write_events
  ADD CONSTRAINT un1t_write_events_op_check
  CHECK (op IN ('create_client', 'forgot_password', 'trial', 'book', 'cancel', 'checkout', 'trial_regrant', 'fee_charge', 'move', 'comp_credits'));

ALTER TABLE public.un1t_write_events
  ADD COLUMN IF NOT EXISTS comp_amount          smallint,
  ADD COLUMN IF NOT EXISTS comp_expires_in_days smallint,
  ADD COLUMN IF NOT EXISTS comp_use_by          date,
  ADD COLUMN IF NOT EXISTS comp_reason          text,
  ADD COLUMN IF NOT EXISTS comp_note            text,
  ADD COLUMN IF NOT EXISTS comp_expires_at      timestamptz;

ALTER TABLE public.un1t_write_events
  DROP CONSTRAINT IF EXISTS un1t_write_events_comp_check;
ALTER TABLE public.un1t_write_events
  ADD CONSTRAINT un1t_write_events_comp_check
  CHECK (
    -- COALESCE: a NULL amount or reason makes the conjunction NULL, which a
    -- CHECK would let through.
    CASE WHEN op = 'comp_credits' THEN COALESCE(
      un1t_user_id IS NOT NULL
      AND actor_user_id IS NOT NULL
      AND origin = 'staff'
      AND comp_amount BETWEEN 1 AND 10
      AND comp_expires_in_days BETWEEN 1 AND 365
      AND comp_use_by IS NOT NULL
      AND comp_reason IN ('goodwill', 'injury', 'class_cancelled', 'referral_reward', 'other')
      AND (comp_note IS NULL OR char_length(comp_note) <= 200), false)
    ELSE
      comp_amount IS NULL AND comp_expires_in_days IS NULL AND comp_use_by IS NULL
      AND comp_reason IS NULL AND comp_note IS NULL AND comp_expires_at IS NULL
    END
  );

-- The card's "Complimentary credits given" read: one person at one studio, newest first.
CREATE INDEX IF NOT EXISTS un1t_write_events_comp_given
  ON public.un1t_write_events (location_id, un1t_user_id, created_at DESC)
  WHERE op = 'comp_credits';

COMMENT ON COLUMN public.un1t_write_events.comp_amount IS
  'UN1TCOMP.1 (mig 787): complimentary credits a member of staff gave (1 to 10). comp_credits rows only.';
COMMENT ON COLUMN public.un1t_write_events.comp_expires_in_days IS
  'UN1TCOMP.1 (mig 787): the expiresInDays sent to POST /credits/grant (whole calendar days from the studio''s today to comp_use_by). comp_credits rows only.';
COMMENT ON COLUMN public.un1t_write_events.comp_use_by IS
  'UN1TCOMP.1 (mig 787): the use-by day staff chose, a calendar day on the studio''s clock. comp_credits rows only.';
COMMENT ON COLUMN public.un1t_write_events.comp_reason IS
  'UN1TCOMP.1 (mig 787): why the credits were given (goodwill, injury, class_cancelled, referral_reward, other). comp_credits rows only.';
COMMENT ON COLUMN public.un1t_write_events.comp_note IS
  'UN1TCOMP.1 (mig 787): the optional team note (plain text, <= 200 characters; the app refuses an email address or phone number). comp_credits rows only.';
COMMENT ON COLUMN public.un1t_write_events.comp_expires_at IS
  'UN1TCOMP.1 (mig 787): the expires_at un1t.online answered a done grant with (or the landed batch''s, when a check read found it). comp_credits rows only.';

COMMENT ON TABLE public.un1t_write_events IS
  'UN1TWRITE.1 (mig 744): one row per un1t.online write attempt (book, cancel, create_client, forgot_password, trial, checkout; trial_regrant since mig 760; fee_charge since mig 781; move since mig 786; comp_credits since mig 787). The write-ahead marker, the resume point for retries and approvals, the dedupe of the CRM''s own attempts and the audit trail. Keys: create:<loc>:<contact>, trial:<loc>:<un1tUser>:<product>:<method>, trial_regrant:<loc>:<un1tUser>, book:<loc>:<un1tUser>:<event>, cancel:<loc>:<booking>, move:<loc>:<booking>:<event> (late_window since mig 786), comp:<loc>:<un1tUser>:<request> (the comp_* columns since mig 787), fee:<loc>:<fee>:<n>, pw:<loc>:<un1tUser>:<n>, checkout = the caller''s key (also the idempotency-key header on purchase and credit-grant calls). message is <= 500 chars and never carries a password, token, email or phone. Service role only.';

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
    RAISE EXCEPTION 'mig 787: un1t_write_events_op_check missing';
  END IF;
  FOREACH k IN ARRAY ARRAY['create_client', 'forgot_password', 'trial', 'book', 'cancel', 'checkout', 'trial_regrant', 'fee_charge', 'move', 'comp_credits'] LOOP
    IF d NOT LIKE '%''' || k || '''%' THEN
      RAISE EXCEPTION 'mig 787: un1t_write_events_op_check does not admit %: %', k, d;
    END IF;
  END LOOP;
  FOREACH k IN ARRAY ARRAY['comp_amount', 'comp_expires_in_days', 'comp_use_by', 'comp_reason', 'comp_note', 'comp_expires_at'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name = 'un1t_write_events'
                     AND column_name = k AND is_nullable = 'YES') THEN
      RAISE EXCEPTION 'mig 787: un1t_write_events.% missing or NOT NULL', k;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.un1t_write_events'::regclass AND conname = 'un1t_write_events_comp_check') THEN
    RAISE EXCEPTION 'mig 787: un1t_write_events_comp_check missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                 WHERE schemaname = 'public' AND tablename = 'un1t_write_events' AND indexname = 'un1t_write_events_comp_given') THEN
    RAISE EXCEPTION 'mig 787: un1t_write_events_comp_given missing';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.table_privileges
             WHERE table_schema = 'public' AND table_name = 'un1t_write_events'
               AND grantee IN ('anon', 'authenticated', 'PUBLIC')) THEN
    RAISE EXCEPTION 'mig 787: a client role holds a privilege on un1t_write_events';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.column_privileges
             WHERE table_schema = 'public' AND table_name = 'un1t_write_events'
               AND grantee IN ('anon', 'authenticated', 'PUBLIC')) THEN
    RAISE EXCEPTION 'mig 787: a client role holds a column privilege on un1t_write_events';
  END IF;
END;
$$;

COMMIT;
