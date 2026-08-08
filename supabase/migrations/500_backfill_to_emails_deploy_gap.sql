-- EMAIL-CC.2 — close the to_emails gap opened between mig 499 and EMAIL-CC.1's deploy.
--
-- WHY THIS EXISTS AT ALL
-- Mig 499 added email_inbox_messages.to_emails and backfilled the whole
-- back-catalogue (to_emails = ARRAY[to_email]). That backfill ran at APPLY time.
-- The code that WRITES to_emails shipped later, in EMAIL-CC.1.
--
-- Between those two moments the column existed and nothing populated it, so any
-- message sent in that window has to_email set and to_emails EMPTY. Exactly one
-- row landed there in production — a ticket reply at 2026-08-07 22:41:59Z, sent
-- while EMAIL-CC.1 was still in review.
--
-- It is invisible today because no deployed reader consults to_emails yet. It
-- stops being invisible the moment the thread starts rendering the array, at
-- which point that message reads as "sent to nobody" — in the one surface where
-- that is worst, and for a message that was in fact delivered successfully.
--
-- Mig 499's own header names this hazard ("an empty to_emails on a row that has
-- a to_email would otherwise read as 'sent to nobody'"). It closed it for
-- everything written BEFORE the migration; this closes it for the window AFTER.
--
-- APPLY ORDER MATTERS: this must run AFTER EMAIL-CC.1 is deployed. Run earlier
-- and the next message sent before the deploy reopens the same gap.
--
-- IDEMPOTENT BY CONSTRUCTION. The predicate matches only rows that still have an
-- empty array, so re-running it is a no-op and it can be run again safely if
-- another gap is ever discovered. It never overwrites a populated to_emails,
-- so a genuine multi-recipient row written by EMAIL-CC.1 is untouched.

UPDATE public.email_inbox_messages
   SET to_emails = ARRAY[to_email]
 WHERE to_email IS NOT NULL
   AND cardinality(to_emails) = 0;
