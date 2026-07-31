-- 465_geofence_dedupe_index.sql
-- GEO-ATT.16 — concurrency backstop for geofence check-in dedup.
--
-- The route's dedup is a SELECT (any geofence event for this
-- profile+location in the last 10 min?) followed by an INSERT. Two
-- concurrent OS region-ENTER fires can both clear the SELECT before
-- either INSERTs — observed live 2026-07-31: two identical rows for
-- the same arrival, 43 ms apart. The shift stamp itself was never at
-- risk (that UPDATE is race-guarded on start_time_override IS NULL);
-- the damage is duplicate audit rows on essentially every arrival.
--
-- Fix: a partial unique index on the minute bucket of event_at. The
-- bucket is date_trunc('minute', event_at AT TIME ZONE 'UTC') --
-- `AT TIME ZONE <literal>` on a timestamptz is IMMUTABLE and yields a
-- plain timestamp date_trunc can bucket immutably. (extract(epoch FROM
-- timestamptz) is only STABLE -- Postgres rejects it with 42P17.)
-- Scoped to source='geofence' so the UniFi Access/Protect pipelines
-- (which legitimately fire twice per arrival — that corroboration is
-- the whole point of defence in depth) are untouched.
--
-- The route now maps a 23505 from this index to a terminal
-- { success:true, match_outcome:'duplicate' } so the phone's retry
-- queue dequeues instead of retrying forever.

-- Existing duplicates must go first or the index build fails. Keep the
-- earliest row per (profile, location, minute); the loser is byte-wise
-- identical apart from received_at.
DELETE FROM public.staff_attendance_events a
USING public.staff_attendance_events b
WHERE a.source = 'geofence'
  AND b.source = 'geofence'
  AND a.profile_id  = b.profile_id
  AND a.location_id = b.location_id
  AND date_trunc('minute', a.event_at AT TIME ZONE 'UTC')
    = date_trunc('minute', b.event_at AT TIME ZONE 'UTC')
  AND a.received_at > b.received_at;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_geofence_event_per_minute
  ON public.staff_attendance_events (
    profile_id,
    location_id,
    (date_trunc('minute', event_at AT TIME ZONE 'UTC'))
  )
  WHERE source = 'geofence';

COMMENT ON INDEX public.uniq_geofence_event_per_minute IS
  'GEO-ATT (mig 465): one geofence audit row per staff member per location per minute. Backstop for the check-in dedup SELECT->INSERT race (two OS fires 43ms apart, observed live 2026-07-31); the route maps 23505 to a terminal duplicate response.';
