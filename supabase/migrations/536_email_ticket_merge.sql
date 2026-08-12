-- 536 — EMAIL-MERGE.1
-- Two tickets that are really one conversation, folded reversibly.
--
-- WHY status STAYS 'open|pending|solved|closed'
-- A fifth value would have to be audited through every view filter, the count
-- endpoint, the mobile status picker and the needs-reply badge, and this estate
-- has been bitten by a new enum value leaking past a filter that keyed on the
-- old set. A merged ticket is CLOSED plus a pointer; tombstones are hidden by
-- one shared query helper instead.
--
-- WHY THE STAMP ON THE MESSAGES
-- merged_from_ticket_id records which rows moved, so unmerge restores exactly
-- those and nothing else — including on a ticket that had already absorbed a
-- different merge.
alter table email_tickets
  add column if not exists merged_into_id uuid references email_tickets(id),
  add column if not exists merged_at      timestamptz,
  add column if not exists merged_by      uuid references profiles(id);

alter table email_inbox_messages
  add column if not exists merged_from_ticket_id uuid references email_tickets(id);

-- An FK needs its own column LEADING an index, or get_advisors(performance)
-- reports an unindexed foreign key — the mig 496/497 lesson. Both of these are
-- genuinely queried: merged_into_id filters every ticket list (tombstones are
-- hidden by it) and merged_from_ticket_id is how unmerge finds the rows to move.
create index if not exists idx_email_tickets_merged_into
  on email_tickets (merged_into_id);
create index if not exists idx_email_msgs_merged_from
  on email_inbox_messages (merged_from_ticket_id);

-- merged_by IS DELIBERATELY LEFT UNINDEXED, and the advisor's INFO finding on it
-- is accepted rather than missed. It is an audit stamp: nothing filters or joins
-- on "who merged this", and the only other reader is a DELETE on profiles, which
-- essentially never happens here. Indexing it would trade one INFO finding
-- (unindexed_foreign_keys) for another (unused_index) plus write cost on every
-- merge. Two direct precedents on this same table family are already treated the
-- same way: email_bounce_escalations.released_by and
-- email_hygiene_releases.released_by. If a "what did X merge" surface is ever
-- built, add the index then.

comment on column email_tickets.merged_into_id is
  'Set when this ticket was folded into another (mig 536). Non-null = tombstone: hidden from lists, opening it redirects to the survivor.';
