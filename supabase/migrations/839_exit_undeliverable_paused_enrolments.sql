-- SEQUNDELIVERABLE.1 — exit the enrolments paused on an inactive recipient.
--
-- A Postmark 406 ("You tried to send to recipient(s) that have been marked as
-- inactive") used to count as an ordinary step error: four retries, then the
-- enrolment sat 'paused' for good. Live on 15 Nov 2026: 90 enrolments paused
-- on 14-15 Oct this way, against 6 active in the whole estate, and no screen
-- listed them. Retrying can never deliver to an inactive address, so the code
-- now exits such an enrolment at once (src/lib/sequences/scheduler.js,
-- isUndeliverableRecipient). This file applies the same outcome to the rows
-- already stuck, so they read as finished ('exited', exit_reason
-- 'undeliverable') rather than waiting on a resume that would fail again.
--
-- Data only; no schema change. Only rows that are still 'paused' AND whose
-- last_error is Postmark's inactive-recipient refusal are touched; a paused
-- enrolment for any other reason is left for a person to look at.
-- Idempotent: a second run matches nothing. Fictional ids only: the repo is
-- public.

UPDATE public.sequence_enrollments
   SET status = 'exited',
       exit_reason = 'undeliverable',
       exited_at = now(),
       next_step_at = NULL
 WHERE status = 'paused'
   AND last_error LIKE 'You tried to send to recipient(s) that have been marked as inactive%';

-- Self-check: nothing paused on that refusal is left.
DO $$
DECLARE
  left_over int;
BEGIN
  SELECT count(*) INTO left_over
    FROM public.sequence_enrollments
   WHERE status = 'paused'
     AND last_error LIKE 'You tried to send to recipient(s) that have been marked as inactive%';
  IF left_over > 0 THEN
    RAISE EXCEPTION 'mig 839: % inactive-recipient enrolments still paused', left_over;
  END IF;
END;
$$;
