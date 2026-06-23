# Challenge standings — aggregate in Postgres (kill the leaderboard scan)

**Date:** 2026-06-23
**Repos:** un1t-crm (the RPC, via migration on the shared Supabase `iyvtbjjxdggiadzwwvdj`), champ-app (the `loadChallenges` consumer + the Home teaser decouple).

## Problem

The champ-app Home tab felt slow: it loads the primary dashboard data fast (one parallel Supabase batch) but then waits ~3s for secondary "teaser" tiles, which pop in and shove content down. Root cause traced to **`/api/challenges`**: `loadChallenges` (`champ-app/src/lib/load-challenges.js`) computes leaderboard standings by **fetching every member's `heart_rate_sessions` for the challenge window — paginated, up to thousands of rows over multiple round-trips — and summing in JavaScript**, once per active challenge plus a month-window scan for the gym + consistency boards. The Home tab calls this heavy endpoint just to show a one-line challenge teaser (the member's rank).

The slowness is **not** inherent to live standings — it's doing the aggregation in JS over raw rows instead of in the database.

## Decision (Richard, 2026-06-23)

**Optimize the leaderboard so the teaser keeps the live rank AND loads fast.** Chosen over caching/precompute (which adds staleness + a cron + a table) because the metrics are simple SQL aggregates, so moving the math into Postgres keeps standings live with no new machinery.

## Design

### 1. New RPC — un1t-crm migration

`public.challenge_standings(p_location_id uuid, p_from timestamptz, p_to timestamptz)` returns one row per member who trained in `[p_from, p_to)` at the location, with all three challenge metrics aggregated in-DB:

```sql
CREATE FUNCTION public.challenge_standings(p_location_id uuid, p_from timestamptz, p_to timestamptz)
RETURNS TABLE (contact_id uuid, name text, points numeric, classes bigint, z4plus_minutes numeric)
LANGUAGE sql
STABLE
AS $$
  SELECT s.contact_id, c.name,
         COALESCE(SUM(s.effort_points), 0)::numeric                          AS points,
         COUNT(*)::bigint                                                     AS classes,
         (COALESCE(SUM(COALESCE((s.zones_seconds->>'4')::numeric, 0)
                     + COALESCE((s.zones_seconds->>'5')::numeric, 0)), 0) / 60.0)::numeric AS z4plus_minutes
  FROM public.heart_rate_sessions s
  JOIN public.contacts c ON c.id = s.contact_id
  WHERE s.location_id = p_location_id
    AND s.contact_id IS NOT NULL
    AND s.ended_at IS NOT NULL
    AND s.started_at >= p_from
    AND s.started_at <  p_to
  GROUP BY s.contact_id, c.name
$$;
```

- **Index:** uses the existing `idx_hr_sessions_location (location_id, started_at DESC)` — no new index.
- **Metrics map 1:1 to the JS `metricValue`:** `points`=`SUM(effort_points)`, `classes`=`COUNT(*)` (every session, any `source` — so `source='participation'` no-device credits still count, preserving the consistency board's "everybody included" property), `z4plus_minutes`=zone 4+5 seconds ÷ 60. One call per window yields every metric.
- **Security:** the function reads cross-member data, exactly like the current service-client path (customer RLS can't see other members). It is **`SECURITY INVOKER`** (default) with **`EXECUTE` REVOKEd from `anon` and `authenticated`**, granted only to `service_role`. So it works when called by champ-app's service client (service role bypasses RLS) but is **not** invocable by a signed-in member via `/rest/v1/rpc` — no leaderboard data leaks. This is the safest posture and avoids the `SECURITY DEFINER`-exposed advisor warning.

### 2. `champ-app/src/lib/load-challenges.js`

- Replace `windowSessions` (the paginated fetch-all-rows) with a single `svc.rpc('challenge_standings', { p_location_id, p_from, p_to })` per distinct window.
- `standingsFrom(rows, metric)` consumes the **aggregated** rows — it reads the metric column (`points` / `classes` / `z4plus_minutes`) directly instead of summing `metricValue` over raw sessions; `name` comes from the row; then the **unchanged** `rankStandings` ranks the tiny set.
- The collective-challenge total reads the summed metric column instead of reducing raw sessions.
- The month board calls the RPC **once** for the month window and derives both the gym board (rank by `points`) and the consistency board (rank by `classes`) from that single result — same as today (which fetched the month sessions once).
- **Unchanged:** `rankStandings`, `projectForMember`, `challengePhase`, `windowIso`, `shortName`, the returned shapes (`challenges[]`, `gymBoard`, `consistencyBoard`, the teaser fields `me.rank` / `count` / `collective.pct`), and every API route + UI consumer. Ranks, ties, names, and counts are identical — only the data source under the hood changes.

### 3. Home tab teaser decouple — `champ-app/mobile/app/(tabs)/index.jsx`

With `/api/challenges` now fast, also stop the fast tiles waiting on it: set `tierStatus` / `socialTeaser` / `teaserChallenge` state **as each call resolves** (independently) rather than gating all three on one `Promise.all`. With the challenge call fast, the pop-in becomes imperceptible and the multi-tile jump is gone.

## Testing

- **Pure helpers (`shared/challenges.js`):** unchanged — keep their existing tests.
- **`load-challenges` (champ-app):** new test feeding **mock RPC rows** to assert `standingsFrom` + `projectForMember` produce the same standings/ranks/`me` projection the old per-session path produced for equivalent data (lock the equivalence).
- **Live equivalence check:** run `challenge_standings` against the real gym (Stillorgan) for an active challenge window and confirm the per-member totals + ordering match what the current `loadChallenges` returns before the swap.
- champ-app `npm test && npm run lint` + `next build`; un1t-crm advisors clean after the migration.

## Out of scope
- No precompute table, no cron, no cache (Approach B/C rejected — staleness + infra for no benefit at this scale).
- No new index (the existing location+started_at index covers the range scan).
- Challenge definitions, scoring config, the Challenges screen UI, and all API route shapes are untouched.
