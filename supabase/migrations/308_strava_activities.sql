-- 308: personal-only Strava activity store. Strava API Policy §5.4 forbids
-- showing derived Strava data to other members, so this table is read ONLY by
-- the member's own views: member-own RLS, NO location_id, NO staff policy, NO
-- points columns. It is deliberately NOT heart_rate_sessions.
CREATE TABLE strava_activities (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id         uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  strava_activity_id text NOT NULL,
  activity_type      text,
  name               text,
  started_at         timestamptz,
  duration_seconds   numeric,
  distance_meters    numeric,
  calories_kcal      numeric,
  avg_hr_bpm         numeric,
  max_hr_bpm         numeric,
  raw_metadata       jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contact_id, strava_activity_id)
);

CREATE INDEX idx_strava_activities_contact ON strava_activities (contact_id, started_at DESC);

ALTER TABLE strava_activities ENABLE ROW LEVEL SECURITY;

-- Member reads their OWN Strava activities only. No staff cross-read policy by
-- design — it is the member's private Strava data. Writes are service-role only.
CREATE POLICY "Customers view own strava activities" ON strava_activities
  FOR SELECT TO public
  USING (contact_id = (SELECT private.auth_contact_id()));
