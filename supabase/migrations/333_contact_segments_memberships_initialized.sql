-- 333 — contact_segments.memberships_initialized_at
--
-- COMMS-AUDIT batch 6. The segment-membership sync (segment-sync.js) detects
-- "added" by diffing the current filter result against a stored snapshot. On
-- the FIRST sync of a segment there is no snapshot, so EVERY current member
-- shows up as an addition and segment_added sequences fire for the whole
-- pre-existing membership — a mass enrolment the operator never intended.
--
-- This marker records that a segment's baseline snapshot has been
-- established. The first sync persists the baseline + stamps this column and
-- SUPPRESSES the added/removed triggers; every later sync fires triggers on
-- real transitions. NULL = never synced (first run).

alter table contact_segments
  add column if not exists memberships_initialized_at timestamptz;

comment on column contact_segments.memberships_initialized_at is
  'COMMS-AUDIT batch 6 (mig 333) — when the membership snapshot baseline was first established. NULL = never synced; the first sync stamps it and suppresses segment_added/removed triggers so a pre-existing membership is not mass-enrolled.';
