-- 347: tighten the challenge "classes" (attendance) metric.
--
-- Operator decision (Richard, 2026-07-03):
--   A session counts toward the attendance / "classes" challenge metric ONLY if
--   it is BOTH:
--     (1) class-linked  — the member actually attended a scheduled studio class
--         (glofox_event_id stamped: in-studio strap presence, OR a wearable
--         workout auto-mapped to the class because the member was BOOKED into it
--         at class time), AND
--     (2) device-backed — an in-studio HR strap, OR a wearable (Apple Watch /
--         Fitbit / Whoop / Garmin / chest-strap) whose workout was auto-mapped
--         to the class.
--   It must NOT count: workouts done OUTSIDE the studio (glofox_event_id NULL —
--   an off-site wearable import never gets stamped), or workouts with NO
--   monitoring device (a no-device "participation" credit, source='participation',
--   or a legacy source='manual' — both of which CAN carry a glofox_event_id but
--   have no device behind them).
--   POINTS stay fully inclusive — an outside-studio wearable workout still
--   contributes to the points balance. Only the attendance/classes metric tightens.
--
-- Why the source exclusion is required (not just glofox_event_id IS NOT NULL):
--   createParticipationSession() (src/lib/live-class.js) writes a
--   source='participation' row WITH glofox_event_id set (the attended class), so
--   a class-link check alone would wrongly count no-device participation credits.
--   The auto-mapping marker proven in the Apple-Health ingest
--   (src/app/api/wearables/apple-health/ingest/route.js) is glofox_event_id — set
--   only when the member is booked; an off-site import leaves it NULL. So
--   "class-linked AND device-backed" = glofox_event_id IS NOT NULL
--   AND source NOT IN ('participation','manual').
--
-- points         = SUM(effort_points) over ALL sessions        -- UNCHANGED (fully inclusive)
-- classes        = COUNT(*) FILTER (class-linked AND device-backed)  -- TIGHTENED
-- z4plus_minutes = (zone4 + zone5 seconds) / 60 over ALL sessions -- UNCHANGED
--   (z4plus is an EFFORT metric like points, and requires a device by nature —
--    only real HR samples produce zone-4/5 seconds; participation/off-site rows
--    contribute 0 to it already — so it stays inclusive/unchanged.)
--
-- Preserves the exact signature, return columns, SECURITY INVOKER (default),
-- SET search_path = '', and the service_role-only EXECUTE grant from mig 310.

CREATE OR REPLACE FUNCTION public.challenge_standings(
  p_location_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
RETURNS TABLE (contact_id uuid, name text, points numeric, classes bigint, z4plus_minutes numeric)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT s.contact_id,
         c.name,
         COALESCE(SUM(s.effort_points), 0)::numeric AS points,
         COUNT(*) FILTER (
           WHERE s.glofox_event_id IS NOT NULL
             AND s.source NOT IN ('participation', 'manual')
         )::bigint AS classes,
         (COALESCE(SUM(
            COALESCE((s.zones_seconds->>'4')::numeric, 0)
          + COALESCE((s.zones_seconds->>'5')::numeric, 0)
         ), 0) / 60.0)::numeric AS z4plus_minutes
  FROM public.heart_rate_sessions s
  JOIN public.contacts c ON c.id = s.contact_id
  WHERE s.location_id = p_location_id
    AND s.contact_id IS NOT NULL
    AND s.ended_at IS NOT NULL
    AND s.started_at >= p_from
    AND s.started_at <  p_to
  GROUP BY s.contact_id, c.name
$$;

REVOKE EXECUTE ON FUNCTION public.challenge_standings(uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.challenge_standings(uuid, timestamptz, timestamptz) TO service_role;
