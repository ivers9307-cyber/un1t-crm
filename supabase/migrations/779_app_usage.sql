-- 779 USAGE.1 — app usage: staff sessions and per-feature visits on the phone
-- app and the web CRM, plus per-day totals for the platform console's
-- App usage page (/admin/app-usage).
--
-- Apply BEFORE the USAGE.1 code deploys: the trackers post to
-- /api/usage/events from the first page load, and a write to a missing table
-- fails every batch (the clients keep at most 10 and drop the rest).
--
-- WHY. Nothing recorded who used the CRM, when, or which part of it:
-- auth.users.last_sign_in_at keeps one timestamp and phone sessions refresh
-- silently, audit_events records changes and never a screen, and Vercel
-- Analytics is anonymous. Richard (26 Oct 2026) asked for who, when, which
-- features, how long and how many times a day — staff only, phone and web,
-- master-only report. Design: docs/superpowers/specs/2026-10-26-app-usage-design.md.
--
-- MINIMISATION (GDPR, staff monitoring). Only a feature key and start/end
-- times are stored: no path, record id, IP address or user agent. Masters,
-- impersonation ("view as") and support sessions are never recorded. Raw
-- sessions and visits are deleted after 90 days and daily totals after 400
-- days by the app-usage-rollup cron. Staff are told through the staff
-- handbook / privacy notice.
--
-- Service role only: written by POST /api/usage/events, rebuilt by
-- /api/cron/app-usage-rollup, read by /api/admin/app-usage*. No client
-- session reads or writes any of the three tables.

-- One stretch of use: app in the foreground / tab visible and not idle.
-- The id is minted by the client so a re-sent batch upserts, never doubles.
CREATE TABLE public.app_usage_sessions (
  id          uuid        PRIMARY KEY,
  -- profiles are never deleted (tombstoned), so the cascade never fires in
  -- practice; it is here so a hand delete cannot strand rows.
  profile_id  uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  -- The user's active studio when the session started: the studio filter
  -- and the zone the session's day is bucketed in.
  location_id uuid        REFERENCES public.locations(id) ON DELETE SET NULL,
  platform    text        NOT NULL CHECK (platform IN ('phone', 'web')),
  app_version text,
  started_at  timestamptz NOT NULL,
  ended_at    timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (ended_at >= started_at)
);

CREATE INDEX app_usage_sessions_profile_started_idx
  ON public.app_usage_sessions (profile_id, started_at);
CREATE INDEX app_usage_sessions_started_idx
  ON public.app_usage_sessions (started_at);
CREATE INDEX app_usage_sessions_ended_idx
  ON public.app_usage_sessions (ended_at);
CREATE INDEX app_usage_sessions_location_idx
  ON public.app_usage_sessions (location_id);

COMMENT ON TABLE public.app_usage_sessions IS
  'USAGE.1 (mig 779): one staff session on the phone app or web CRM. Client-minted id. Kept 90 days. Service role only.';

-- One visit to a feature inside a session (consecutive screens of the same
-- feature are one visit). Client-minted id; the final end time wins.
CREATE TABLE public.app_usage_visits (
  id          uuid        PRIMARY KEY,
  session_id  uuid        NOT NULL REFERENCES public.app_usage_sessions(id) ON DELETE CASCADE,
  profile_id  uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  feature     text        NOT NULL,
  started_at  timestamptz NOT NULL,
  ended_at    timestamptz NOT NULL,
  CHECK (ended_at >= started_at)
);

CREATE INDEX app_usage_visits_session_idx
  ON public.app_usage_visits (session_id);
CREATE INDEX app_usage_visits_profile_idx
  ON public.app_usage_visits (profile_id);
CREATE INDEX app_usage_visits_started_idx
  ON public.app_usage_visits (started_at);

COMMENT ON TABLE public.app_usage_visits IS
  'USAGE.1 (mig 779): one visit to a feature (shared/usage-features.js key) inside an app_usage_sessions row. Kept 90 days (cascade). Service role only.';

-- Per person, day, platform, feature and studio totals, rebuilt from the raw
-- tables by the rollup cron (re-deriving a day is idempotent; it rebuilds
-- today and the two days before, since a batch may arrive up to 48 h late). feature
-- '_session' carries the session count and the UNION of session time;
-- platform 'all' (only on '_session' rows) is the union across phone and web.
-- location_key is location_id or the nil uuid, so the unique key works for
-- a session with no studio; the all-f uuid marks the cross-studio 'all' row
-- (the union over every studio, location_id NULL), which the report reads
-- when no studio is chosen.
CREATE TABLE public.app_usage_daily (
  id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  profile_id   uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  day          date        NOT NULL,
  platform     text        NOT NULL CHECK (platform IN ('phone', 'web', 'all')),
  feature      text        NOT NULL,
  location_id  uuid        REFERENCES public.locations(id) ON DELETE SET NULL,
  location_key uuid        NOT NULL,
  visits       integer     NOT NULL DEFAULT 0,
  seconds      integer     NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_usage_daily_unique UNIQUE (profile_id, day, platform, feature, location_key)
);

CREATE INDEX app_usage_daily_day_idx ON public.app_usage_daily (day);
CREATE INDEX app_usage_daily_location_idx ON public.app_usage_daily (location_id);

COMMENT ON TABLE public.app_usage_daily IS
  'USAGE.1 (mig 779): per-day app usage totals rebuilt by the app-usage-rollup cron. Kept 400 days. Service role only.';

ALTER TABLE public.app_usage_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_usage_visits   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_usage_daily    ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.app_usage_sessions FROM anon, authenticated;
REVOKE ALL ON public.app_usage_visits   FROM anon, authenticated;
REVOKE ALL ON public.app_usage_daily    FROM anon, authenticated;

-- The report's two reads, aggregated in the database: a 12-month range is
-- tens of thousands of daily rows, far past PostgREST's 1,000-row page.
-- Service role only (the report routes); no client calls them.
--
-- app_usage_summary: per person, platform and feature over [p_from, p_to],
-- the visits, seconds and number of distinct days with use. p_location_id
-- narrows to sessions that started at one studio (NULL = every studio).
CREATE FUNCTION public.app_usage_summary(
  p_from date,
  p_to date,
  p_profile_ids uuid[],
  p_location_id uuid DEFAULT NULL
)
RETURNS TABLE (profile_id uuid, platform text, feature text, visits bigint, seconds bigint, days bigint)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT d.profile_id, d.platform, d.feature,
         sum(d.visits)::bigint, sum(d.seconds)::bigint,
         count(DISTINCT d.day) FILTER (WHERE d.seconds > 0)::bigint
    FROM public.app_usage_daily d
   WHERE d.day BETWEEN p_from AND p_to
     AND d.profile_id = ANY (p_profile_ids)
     AND (
           -- One studio: that studio's rows (the cross-studio row has no
           -- location_id, so it never matches).
           (p_location_id IS NOT NULL AND d.location_id = p_location_id)
           -- Every studio: phone/web and feature rows add up across studios,
           -- but the 'all' session union is the cross-studio row alone, so
           -- phone at one studio and web at another never count twice.
        OR (p_location_id IS NULL AND (d.platform <> 'all'
              OR d.location_key = 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid))
         )
   GROUP BY d.profile_id, d.platform, d.feature
   ORDER BY d.profile_id, d.platform, d.feature
$$;

-- app_usage_last_active: each person's latest session end (any studio).
CREATE FUNCTION public.app_usage_last_active(p_profile_ids uuid[])
RETURNS TABLE (profile_id uuid, last_active_at timestamptz)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT s.profile_id, max(s.ended_at)
    FROM public.app_usage_sessions s
   WHERE s.profile_id = ANY (p_profile_ids)
   GROUP BY s.profile_id
   ORDER BY s.profile_id
$$;

REVOKE EXECUTE ON FUNCTION public.app_usage_summary(date, date, uuid[], uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.app_usage_last_active(uuid[]) FROM PUBLIC, anon, authenticated;

-- The rollup cron runs every 15 minutes. Grace 1200 s: one missed tick
-- (900 + jitter + run time) never pages; two do.
--
-- Born healthy (last_ok_at = now()). If the code deploys more than ~35
-- minutes after this migration, re-run this insert after the deploy
-- (replaying is safe: it refreshes the row and re-arms last_ok_at).
INSERT INTO public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, last_ok_at, notes)
VALUES (
  'app-usage-rollup',
  900,
  1200,
  now(),
  'USAGE.1: rebuilds app_usage_daily from raw sessions/visits and enforces 90/400-day retention'
)
ON CONFLICT (name) DO UPDATE
  SET last_ok_at = now(),
      expected_interval_seconds = excluded.expected_interval_seconds,
      grace_seconds = excluded.grace_seconds,
      notes = excluded.notes;
