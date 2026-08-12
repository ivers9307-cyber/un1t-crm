-- 534 — EMAIL-PARTICIPANTS.1
-- Addresses an operator has explicitly taken OFF a ticket's audience.
--
-- WHY A COLUMN AND NOT A TABLE: the participant set itself is DERIVED from
-- email_inbox_messages on every read, so it cannot drift from the mail that
-- actually arrived. Only the operator's subtractions need storing, and they are
-- a small, unordered set of addresses per ticket. A participants table would be
-- a second source of truth with five write sites (webhook main path, webhook
-- crash-finish path, reply, compose, forward) — miss one and the audience
-- silently narrows, which is the exact defect this work exists to remove.
--
-- Addresses are stored NORMALISED (lowercased, angle-brackets stripped) by
-- src/lib/email-recipients.js normalizeAddress(), so a case variant cannot
-- dodge an exclusion.
alter table email_tickets
  add column if not exists excluded_participants text[] not null default '{}';

comment on column email_tickets.excluded_participants is
  'Normalised addresses removed from this ticket''s reply audience by an operator (mig 534). Empty = derive the audience from the messages alone.';
