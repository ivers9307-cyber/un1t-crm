-- EMAIL-ATTACH.2 — cover the mailbox FK on email_ticket_attachments.
--
-- Mig 496 added email_ticket_attachments.mailbox_id (FK → email_mailboxes,
-- ON DELETE SET NULL) and created
--
--   idx_email_attach_mailbox_created (location_id, mailbox_id, created_at)
--
-- for the prune and reconcile reads, which both scope by location first. That
-- index does NOT cover the foreign key: Postgres can only use an index for an
-- FK's referential action when the FK column LEADS it, and here mailbox_id sits
-- second behind location_id. get_advisors(type=performance) flagged it as
-- unindexed_foreign_keys immediately after 496 applied — the same class mig 483
-- had to come back and fix on this very family of tables, and the class 496's
-- own header comment claimed to have handled (it added the equivalent index on
-- email_storage_usage.mailbox_id, but not on this one).
--
-- What it costs today: nothing visible. The mailbox admin routes shipped with
-- NO DELETE at all — deactivation (active=false) is the removal path precisely
-- so historic tickets keep the address they arrived at — so the SET NULL action
-- only fires if someone hard-deletes a mailbox row in SQL. Then Postgres would
-- seq-scan every attachment row to null the column, under a lock, and that gets
-- worse for exactly as long as the table grows.
--
-- Cheap to fix now while the table is empty; unpleasant to discover later
-- during a manual cleanup that appears to hang.
--
-- The composite index from 496 is KEPT: it serves the location-scoped prune and
-- reconcile paths, which this single-column index does not.

CREATE INDEX IF NOT EXISTS idx_email_attach_mailbox
  ON public.email_ticket_attachments (mailbox_id);

COMMENT ON INDEX public.idx_email_attach_mailbox IS
  'EMAIL-ATTACH.2: covers email_ticket_attachments_mailbox_id_fkey so the ON DELETE SET NULL action does not seq-scan. The composite (location_id, mailbox_id, created_at) cannot serve the FK — mailbox_id is not its leading column.';
