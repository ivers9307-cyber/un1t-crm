-- 784 — FEES.3: dry-run previews, the member notice and the appeal.
--
-- WHY. Richard, 28 Oct 2026:
--   (1) A fee found while charging is paused is a PREVIEW: listed and emailed
--       to staff, never charged. Before this, a paused night wrote 'pending'
--       rows, so un-pausing would have charged the whole dry run at the next
--       17:00. Every 'pending' row on file was written by the paused Hatch dry
--       run (nothing has ever been live), so they all become 'preview'.
--   (2) When charging is on, each member with a fee gets an email at 23:00
--       (what happened, the amount, when it is charged, an appeal link).
--   (3) A member who appeals before the charge HOLDS it: status 'appealed',
--       never charged until staff waive it or choose "charge anyway".
--
-- WHAT.
--   class_fees.status admits 'preview' and 'appealed' (every status allowed
--   before is kept); class_fees_penalty_shape_check is unchanged (both are
--   fee rows with money).
--   New columns: notice_sent_at, appeal_token_hash (sha256 hex of the
--   member's link token; the token itself is never stored), appeal_reason,
--   appeal_text, appealed_at.
--   Existing 'pending' rows → 'preview'.
--
-- GRANTS. class_fees stays service role only (mig 781).
--   -- column-grant: n/a, class_fees has no client privilege (mig 781).
--   appeal_token_hash ends in _hash, so private.audit_is_secret_key() would
--   mask it if the table ever gained an audit trigger (it has none).
--
-- LOCKS. One transaction, 5s lock_timeout; class_fees is tiny.
--
-- ORDER. Apply BEFORE the FEES.3 code deploys: until then a paused night's
-- 'preview' insert is refused by the status CHECK and the night's list fails
-- (nothing is charged in between).

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.class_fees ADD COLUMN IF NOT EXISTS notice_sent_at timestamptz;
ALTER TABLE public.class_fees ADD COLUMN IF NOT EXISTS appeal_token_hash text;
ALTER TABLE public.class_fees ADD COLUMN IF NOT EXISTS appeal_reason text;
ALTER TABLE public.class_fees ADD COLUMN IF NOT EXISTS appeal_text text;
ALTER TABLE public.class_fees ADD COLUMN IF NOT EXISTS appealed_at timestamptz;

ALTER TABLE public.class_fees
  DROP CONSTRAINT IF EXISTS class_fees_status_check;
ALTER TABLE public.class_fees
  ADD CONSTRAINT class_fees_status_check
  CHECK (status IN ('preview', 'pending', 'waived', 'charging', 'charged', 'retry_scheduled', 'outstanding', 'recorded', 'appealed'));

ALTER TABLE public.class_fees
  DROP CONSTRAINT IF EXISTS class_fees_appeal_reason_check;
ALTER TABLE public.class_fees
  ADD CONSTRAINT class_fees_appeal_reason_check
  CHECK (appeal_reason IS NULL OR appeal_reason IN ('illness', 'injury', 'emergency', 'other'));

ALTER TABLE public.class_fees
  DROP CONSTRAINT IF EXISTS class_fees_appeal_text_length_check;
ALTER TABLE public.class_fees
  ADD CONSTRAINT class_fees_appeal_text_length_check
  CHECK (char_length(appeal_text) <= 1000);

-- An appeal carries its reason and time; a status of appealed has both.
ALTER TABLE public.class_fees
  DROP CONSTRAINT IF EXISTS class_fees_appeal_shape_check;
ALTER TABLE public.class_fees
  ADD CONSTRAINT class_fees_appeal_shape_check
  CHECK ((appealed_at IS NULL) = (appeal_reason IS NULL) AND (status <> 'appealed' OR appealed_at IS NOT NULL));

CREATE UNIQUE INDEX IF NOT EXISTS class_fees_appeal_token_unique
  ON public.class_fees (appeal_token_hash)
  WHERE appeal_token_hash IS NOT NULL;

-- Every pending row on file was written by the paused Hatch dry run.
UPDATE public.class_fees SET status = 'preview' WHERE status = 'pending';

COMMENT ON COLUMN public.class_fees.appeal_token_hash IS
  'FEES.3 (mig 784): sha256 hex of the member''s appeal-link token (the token itself is never stored).';
COMMENT ON COLUMN public.class_fees.notice_sent_at IS
  'FEES.3 (mig 784): when the member''s fee notice email was sent (only while charging is on).';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.class_fees WHERE status = 'pending') THEN
    RAISE EXCEPTION 'mig 784: a pending class fee survived the dry-run conversion';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'class_fees' AND column_name = 'appeal_token_hash') THEN
    RAISE EXCEPTION 'mig 784: class_fees.appeal_token_hash missing';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.table_privileges
             WHERE table_schema = 'public' AND table_name = 'class_fees'
               AND grantee IN ('anon', 'authenticated', 'PUBLIC')) THEN
    RAISE EXCEPTION 'mig 784: a client role holds a privilege on class_fees';
  END IF;
END;
$$;

COMMIT;
