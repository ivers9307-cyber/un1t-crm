-- 312: enforce ONE active connection per (contact_id, provider).
--
-- Bug (confirmed live 2026-06-23): the OAuth callback upserted with
-- onConflict (contact_id, provider, disconnected_at). Because disconnected_at
-- is NULL on an active row and Postgres treats NULLs as DISTINCT in a unique
-- index, reconnecting a provider INSERTed a SECOND active row instead of
-- updating the existing one. A member ended up with 2 active strava rows.
--
-- Downstream breakage: the Strava push webhook resolves the member via
-- .eq(external_athlete_id).is(disconnected_at, null).maybeSingle(), and
-- maybeSingle() throws on >1 row — so real-time ingest silently failed for any
-- member with duplicate active rows.
--
-- Fix: a PARTIAL unique index over active rows only. It must be partial (not a
-- plain 3-column unique) because we KEEP disconnected history rows for audit —
-- uniqueness should only bind rows where disconnected_at IS NULL. A non-partial
-- partial index on the same columns already exists (idx_contact_ext_int_contact
-- _active); we replace it with the unique version (same columns + predicate, so
-- it serves the same lookups). The legacy 3-column unique key is left in place.
--
-- NOTE for the callback: PostgREST/Postgres cannot use a PARTIAL unique index
-- as an ON CONFLICT arbiter (the predicate can't be expressed via PostgREST's
-- on_conflict=cols), so the callback was changed to an explicit
-- update-active-else-insert instead of .upsert(). This index is the hard
-- DB-level guarantee that makes that race-safe.

BEGIN;

-- Defensive: soft-disconnect any pre-existing duplicate ACTIVE rows, keeping
-- the most-recent per (contact_id, provider), so the unique index can be
-- created even in an environment that already has dupes. No-op when clean.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY contact_id, provider
           ORDER BY connected_at DESC NULLS LAST, id DESC
         ) AS rn
  FROM contact_external_integrations
  WHERE disconnected_at IS NULL
)
UPDATE contact_external_integrations c
SET disconnected_at = now(),
    last_error = 'auto-disconnected duplicate active row (mig 312)'
FROM ranked
WHERE c.id = ranked.id AND ranked.rn > 1;

-- The non-unique partial index is now redundant with the unique one below.
DROP INDEX IF EXISTS idx_contact_ext_int_contact_active;

CREATE UNIQUE INDEX uniq_contact_ext_int_active
  ON contact_external_integrations (contact_id, provider)
  WHERE disconnected_at IS NULL;

COMMIT;
