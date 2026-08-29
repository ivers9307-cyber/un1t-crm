-- RETIRE-TICKETS.1 — the A/B is over: Mail won, the ticketing surface retires.
--
-- The mig-575 trial put each mailbox on one of two surfaces and let usage
-- decide. It did: accounts@hatchstreetfitness.com (100% of real conversations)
-- moved to Mail on 2026-08-29 and Richard called the result — the ticket queue
-- is deleted from the web app and every mailbox now lives on the mail surface.
--
-- This migration moves the two remaining rows (stillorgan@un1t.com and
-- hatchstreet@un1t.com — both empty shells with zero conversations, so the
-- move is unobservable in any list) and flips the default so a mailbox created
-- before the retiring code deploys still lands on the only surface that
-- exists.
--
-- `surface` itself follows the house deprecation rule: the column STAYS on
-- disk, code stops reading and writing it, and a LATER migration drops it.
-- The CHECK constraint from mig 575 stays with it — harmless on a column
-- nothing writes.
--
-- 🔴 /api/email/tickets (list + count) remain DEPRECATED SHIMS, not deleted:
-- the staff app's shipped bundle calls them, and an OTA reaches a phone on
-- next launch, not on deploy — deleting the routes in the same merge as the
-- mobile port would break every phone that hadn't relaunched yet. The shims
-- go in a later sweep, after the mobile Mail port's OTA has had time to land.

UPDATE public.email_mailboxes SET surface = 'inbox' WHERE surface <> 'inbox';

ALTER TABLE public.email_mailboxes ALTER COLUMN surface SET DEFAULT 'inbox';

COMMENT ON COLUMN public.email_mailboxes.surface IS
  'DEPRECATED (mig 578) — the mig-575 A/B switch between the ticket queue and the mail surface. The trial ended 2026-08-29: Mail won, the ticket queue is deleted, every row is ''inbox'' and nothing reads or writes this column any more. A later migration drops it.';
