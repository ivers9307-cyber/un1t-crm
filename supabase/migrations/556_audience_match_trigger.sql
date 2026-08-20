-- AUDIENCEMATCH.1 — a sequence can enrol its own audience, once a human says so.
--
-- THE GAP
-- To start a sequence against people who already exist, someone had to call
-- the enrol route by hand with explicit contact ids (capped at 1000 per call,
-- and enrolContacts does not evaluate audience_filter at all, so the caller
-- also had to pre-filter). Starting the 3-Class Trial sequence meant two
-- hand-built API calls against a hand-built list of 2,450 people. That is a
-- script pretending to be a feature.
--
-- WHY NOT SEGMENTS
-- src/lib/sequences/segment-sync.js already does the ONGOING half beautifully:
-- a */5 cron recomputes a segment's members, diffs against a snapshot, and
-- fires segment_added on the additions. But its first-sync guard
-- (segment-sync.js, "First-sync guard") deliberately SUPPRESSES the very first
-- sweep, because on a first snapshot every current member looks like an
-- addition and firing segment_added for a whole pre-existing membership would
-- both mass-enrol people who did not just join AND be a factual lie about what
-- happened. That guard is correct and is NOT touched by this migration.
--
-- What the guard actually was: a decision recorded in code because there was
-- nowhere else to record it. contact_segments has memberships_initialized_at
-- ("we have snapshotted this") but no field meaning "a named human looked at
-- this population, saw the number, and said enrol them". Faced with a decision
-- it could not represent, suppression was the only safe default.
--
-- audience_seeded_at / _by / _count ARE that missing field. Once the decision
-- exists in the schema the sweep acts on a recorded intent instead of guessing,
-- which is exactly the deliberate-vs-accidental line the guard was drawing by
-- hand. An audience_match sequence with audience_seeded_at NULL behaves
-- identically to a guarded first sync: the sweep sees it, enrols nobody, and
-- moves on — forever, until a human decides otherwise. The safe behaviour is
-- what you get by not thinking about it.
--
-- NO NEW TABLES, DELIBERATELY. A segment needs a membership table to remember
-- who was in it; a sequence does not. sequence_enrollments already carries one
-- permanent row per (sequence, contact) — verified: the live index
-- sequence_enrollments_sequence_id_contact_id_key is a FULL unique with no
-- WHERE clause, so the row survives every status transition forever. A
-- membership row is deleted the moment someone leaves the filter; an enrolment
-- row is not. So "matches the audience now AND has no enrolment row" is exactly
-- "newly matching, never handled", with zero new state. On the first swept tick
-- that set is the whole backfill; on every tick after it is a handful. The
-- backfill and the ongoing enrolment are one code path.

alter table public.email_sequences
  add column if not exists audience_seeded_at  timestamptz,
  add column if not exists audience_seeded_by  uuid,
  add column if not exists audience_seed_count integer;

comment on column public.email_sequences.audience_seeded_at is
  'AUDIENCEMATCH.1 — set when an operator explicitly confirmed enrolling everyone who '
  'currently matches audience_filter. NULL is the safe default and means the '
  'audience_match sweep enrols NOBODY, no matter how long the sequence has been active: '
  'publishing and activating can never mass-enrol on their own. Cleared whenever '
  'audience_filter changes, so a widened audience must be re-confirmed against its new '
  'number rather than silently sweeping in the additions.';

comment on column public.email_sequences.audience_seeded_by is
  'AUDIENCEMATCH.1 — profiles.id of the operator who confirmed. No FK, matching the '
  'existing created_by column on this table. The point is accountability for an '
  'irreversible action: sequence_enrollments has a FULL unique on (sequence_id, '
  'contact_id), so a contact enrolled by mistake cannot be un-enrolled and re-run.';

comment on column public.email_sequences.audience_seed_count is
  'AUDIENCEMATCH.1 — the headcount the operator was shown and typed back to confirm. '
  'Kept for the audit trail and to show drift ("you confirmed 2,480; 3,900 match now"). '
  'Not a cap: the sweep enrols whoever matches at sweep time, because the audience is a '
  'continuing condition and pinning to a stale id list would be its own bug.';
