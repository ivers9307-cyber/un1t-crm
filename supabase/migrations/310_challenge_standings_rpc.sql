-- 310: challenge_standings aggregate RPC.
--
-- Moves leaderboard standings math out of JS (champ-app loadChallenges used to
-- fetch EVERY member's heart_rate_sessions for a window — paginated, thousands of
-- rows over multiple round-trips — and sum in JavaScript, per active challenge +
-- a month scan) and into a single GROUP BY in Postgres. Returns one row per member
-- who trained in [p_from, p_to) at the location, with all three challenge metrics
-- aggregated in-DB so the caller fetches ~tens of rows, not thousands. Keeps
-- standings LIVE (no cache/cron). Uses the existing idx_hr_sessions_location.
--
-- Metrics map 1:1 to shared/challenges.js metricValue():
--   points         = SUM(effort_points)
--   classes        = COUNT(*)  (every session, any source — so source='participation'
--                               no-device credits count, preserving the consistency
--                               board's "everybody included" property)
--   z4plus_minutes = (zone4 + zone5 seconds) / 60
--
-- SECURITY: reads cross-member data (the same reason the old path used the service
-- client — customer RLS can't see other members). SECURITY INVOKER (default) with
-- EXECUTE revoked from anon/authenticated and granted only to service_role, so it
-- works for champ-app's service client but is NOT invocable by a signed-in member
-- via /rest/v1/rpc (no leaderboard leak, and no SECURITY DEFINER advisor warning).
-- search_path pinned empty + all objects fully-qualified for robustness.

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
         COUNT(*)::bigint AS classes,
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
