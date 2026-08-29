-- RETIRE-TICKETS.2 — the deferred half of mig 578's deprecation: drop
-- email_mailboxes.surface.
--
-- Mig 578 (2026-08-29) ended the mig-575 surface A/B: every row was set to
-- 'inbox', the default was flipped, the column was COMMENTed DEPRECATED and
-- every reader was removed in the same PR (#1556). Three merges of code have
-- shipped since with nothing reading or writing it, which is the rollback
-- window the keep-on-disk rule exists to protect — a rollback deep enough to
-- resurrect a `surface` reader would also resurrect the deleted ticket-queue
-- UI, which nobody is rolling back to.
--
-- The mig-575 CHECK constraint drops with its column.

ALTER TABLE public.email_mailboxes DROP COLUMN IF EXISTS surface;
