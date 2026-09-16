-- 610 — ARRIVAL.1: move geofence arrival stamps out of the paid window.
--
-- APPLY ONLY AFTER the ARRIVAL.1 code is live. Until then the old check-in
-- route keeps writing start_time_override and would leave new stamps behind.
--
-- A stamp is recognised three ways (only blocks since GEO-ATT.4, 2026-07-31):
--   event_linked     a geofence attendance event matched this assignment and
--                    its event time, rendered in the location's timezone to
--                    the second, equals the override. Strongest evidence.
--   duplicate_orphan no event row; the override has non-zero seconds (every
--                    manual override written since go-live has :00 seconds —
--                    the API schema would accept seconds, but nothing has
--                    ever used them); the same coach has the SAME override on
--                    an earlier-starting block that day. The second half of a
--                    double stamp: not an arrival for this shift, so
--                    arrived_at stays NULL.
--   seconds_orphan   no event row, non-zero seconds, not a duplicate.
--                    arrived_at is recovered from the override only when the
--                    row was written within 10 minutes of that instant (a
--                    real stamp is written as it happens). Otherwise it was
--                    carried forward by copy-week/copy-month and arrived_at
--                    stays NULL.
--
-- The 45-minute rule (D-D, src/lib/staff-attendance.js): decideGeofenceStamp
-- never matches a shift more than 45 minutes before its start (and never past
-- its end), so a recovered candidate the new code would itself have refused
-- is not treated as an arrival either. event_linked and seconds_orphan
-- candidates are therefore additionally kept ONLY when candidate_arrival
-- falls within [block start − 45 minutes, block end] for that assignment's
-- own block, computed in the location's timezone. duplicate_orphan never
-- carried an arrived_at value in the first place, so the window adds nothing
-- there. A row whose candidate falls outside the window still gets its
-- override cleared (it was never a valid paid-window value either way), with
-- arrived_at left NULL.
--
-- Every cleared value is kept in private.shift_assignment_arrival_backfill_610.
--
-- CAVEATS
-- ───────
-- - If a manager changes start_time_override between this migration's
--   classification pass and its UPDATE, an audit row is still recorded but
--   the override is NOT cleared for that assignment — the UPDATE's WHERE
--   equality guard (a.start_time_override = bf.old_start_time_override) skips
--   it rather than clobbering the newer manual value.
-- - The orphan candidate is placed on the block's own date (block_date +
--   override, in the location tz) — a stamp genuinely made before midnight
--   for a next-day early shift would be misdated onto the wrong day. None
--   exist in the current data (checked against the 2026-07-31 cutoff above).
--
-- REPLAY is a no-op: cleared overrides are NULL so nothing re-classifies, and
-- the UPDATE only touches rows whose override still equals the recorded value.

CREATE TABLE IF NOT EXISTS private.shift_assignment_arrival_backfill_610 (
  assignment_id           uuid PRIMARY KEY,
  old_start_time_override time NOT NULL,
  reason                  text NOT NULL CHECK (reason IN ('event_linked', 'seconds_orphan', 'duplicate_orphan')),
  arrived_at              timestamptz,
  recorded_at             timestamptz NOT NULL DEFAULT now()
);

WITH stamps AS (
  SELECT
    a.id,
    a.profile_id,
    a.start_time_override AS ov,
    a.updated_at,
    b.block_date,
    b.start_time AS block_start,
    b.end_time AS block_end,
    COALESCE(l.timezone, 'Europe/Dublin') AS tz,
    (
      SELECT min(e.event_at)
      FROM public.staff_attendance_events e
      WHERE e.matched_assignment_id = a.id
        AND e.source = 'geofence'
        AND e.match_outcome IN ('matched', 'already_stamped')
        AND date_trunc('second', e.event_at AT TIME ZONE COALESCE(l.timezone, 'Europe/Dublin'))::time = a.start_time_override
    ) AS linked_event_at
  FROM public.shift_assignments a
  JOIN public.shift_blocks b ON b.id = a.block_id
  JOIN public.locations l ON l.id = b.location_id
  WHERE a.start_time_override IS NOT NULL
    AND b.block_date >= DATE '2026-07-31'
),
classified AS (
  SELECT
    s.id,
    s.ov,
    s.updated_at,
    (s.block_date + s.block_start) AT TIME ZONE s.tz AS block_start_ts,
    (s.block_date + s.block_end)   AT TIME ZONE s.tz AS block_end_ts,
    CASE
      WHEN s.linked_event_at IS NOT NULL THEN 'event_linked'
      WHEN extract(second FROM s.ov) = 0 THEN NULL
      WHEN EXISTS (
        SELECT 1 FROM stamps t
        WHERE t.profile_id = s.profile_id
          AND t.block_date = s.block_date
          AND t.ov = s.ov
          AND t.id <> s.id
          AND t.block_start < s.block_start
      ) THEN 'duplicate_orphan'
      ELSE 'seconds_orphan'
    END AS reason,
    COALESCE(s.linked_event_at, (s.block_date + s.ov) AT TIME ZONE s.tz) AS candidate_arrival
  FROM stamps s
)
INSERT INTO private.shift_assignment_arrival_backfill_610 (assignment_id, old_start_time_override, reason, arrived_at)
SELECT
  c.id,
  c.ov,
  c.reason,
  CASE
    WHEN c.reason = 'event_linked'
         AND c.candidate_arrival >= c.block_start_ts - interval '45 minutes'
         AND c.candidate_arrival <= c.block_end_ts
         THEN c.candidate_arrival
    WHEN c.reason = 'seconds_orphan'
         AND abs(extract(epoch FROM (c.updated_at - c.candidate_arrival))) <= 600
         AND c.candidate_arrival >= c.block_start_ts - interval '45 minutes'
         AND c.candidate_arrival <= c.block_end_ts
         THEN c.candidate_arrival
    ELSE NULL
  END
FROM classified c
WHERE c.reason IS NOT NULL
ON CONFLICT (assignment_id) DO NOTHING;

UPDATE public.shift_assignments a
SET start_time_override = NULL,
    arrived_at = COALESCE(a.arrived_at, bf.arrived_at),
    arrival_source = CASE
      WHEN a.arrived_at IS NULL AND bf.arrived_at IS NOT NULL THEN 'geofence'
      ELSE a.arrival_source
    END
FROM private.shift_assignment_arrival_backfill_610 bf
WHERE bf.assignment_id = a.id
  AND a.start_time_override = bf.old_start_time_override;
