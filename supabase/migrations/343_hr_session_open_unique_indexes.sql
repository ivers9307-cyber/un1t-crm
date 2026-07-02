-- HR-RACE (P0-7) — a uniqueness backstop for OPEN heart_rate_sessions.
--
-- findOrCreateAutoSession / findOrCreateAnonymousSession in
-- src/lib/bridge-samples.js are check-then-insert with NO database guard: two
-- overlapping /api/bridge/samples POSTs (a slow request + the next flush, or
-- two bridges covering one room) each pass the "any open session?" SELECT and
-- BOTH insert -> duplicated open sessions, split samples, two post-class
-- emails. Two partial unique indexes make the DB the arbiter; the code catches
-- 23505 and re-selects the winner (never null, never throws).
--
--   1. one OPEN session per (member, location)
--   2. one OPEN anonymous session per (strap, location)
--
-- Verified against the live DB before writing: 0 duplicate open sessions
-- (45 sessions all-time, early pilot) — the indexes build cleanly today.
--
-- Each index is preceded by a DEFENSIVE dedup UPDATE that closes any
-- pre-existing duplicate OPEN rows per group (keep the MAX(started_at) open,
-- close the rest) so a CREATE UNIQUE INDEX can never fail to build if a
-- duplicate races in between now and apply. A no-op on today's data.

-- (1) One open session per member per location -----------------------------

-- Close pre-existing duplicate OPEN member sessions, keeping the newest open.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY contact_id, location_id
           ORDER BY started_at DESC, id DESC
         ) AS rn,
         last_sample_at, started_at
  FROM public.heart_rate_sessions
  WHERE ended_at IS NULL AND contact_id IS NOT NULL
)
UPDATE public.heart_rate_sessions s
SET ended_at = coalesce(r.last_sample_at, r.started_at, now())
FROM ranked r
WHERE s.id = r.id AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_sessions_open_member
  ON public.heart_rate_sessions (contact_id, location_id)
  WHERE ended_at IS NULL AND contact_id IS NOT NULL;

-- (2) One open anonymous session per strap per location ---------------------

-- Close pre-existing duplicate OPEN anonymous sessions, keeping the newest.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY location_id, device_identifier
           ORDER BY started_at DESC, id DESC
         ) AS rn,
         last_sample_at, started_at
  FROM public.heart_rate_sessions
  WHERE ended_at IS NULL AND contact_id IS NULL AND device_identifier IS NOT NULL
)
UPDATE public.heart_rate_sessions s
SET ended_at = coalesce(r.last_sample_at, r.started_at, now())
FROM ranked r
WHERE s.id = r.id AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_sessions_open_anon
  ON public.heart_rate_sessions (location_id, device_identifier)
  WHERE ended_at IS NULL AND contact_id IS NULL AND device_identifier IS NOT NULL;

COMMENT ON INDEX public.uq_hr_sessions_open_member IS
  'One OPEN heart_rate_session per (contact_id, location_id); backstops findOrCreateAutoSession check-then-insert race (mig 343)';
COMMENT ON INDEX public.uq_hr_sessions_open_anon IS
  'One OPEN anonymous heart_rate_session per (location_id, device_identifier); backstops findOrCreateAnonymousSession race (mig 343)';
