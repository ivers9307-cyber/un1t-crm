-- 299: Challenges — operator-created leaderboard/collective competitions.
-- Standings are computed on read (no standings table). announced_* = cron idempotency.
CREATE TABLE IF NOT EXISTS public.challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  name text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('individual','collective')),
  metric text NOT NULL CHECK (metric IN ('points','classes','z4plus_minutes')),
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  target integer,
  created_by uuid REFERENCES public.profiles(id),
  announced_start_at timestamptz,
  announced_end_at timestamptz,
  announced_target_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_challenges_location_ends ON public.challenges(location_id, ends_on);

ALTER TABLE public.challenges ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff manage challenges at their locations"
  ON public.challenges FOR ALL TO public
  USING ((SELECT private.auth_is_master()) OR private.auth_is_in_location(location_id))
  WITH CHECK ((SELECT private.auth_is_master()) OR private.auth_is_in_location(location_id));

CREATE POLICY "Customers read active challenges at their location"
  ON public.challenges FOR SELECT TO public
  USING (
    ends_on >= (now() AT TIME ZONE 'utc')::date
    AND EXISTS (
      SELECT 1 FROM public.contacts c
      WHERE c.id = (SELECT private.auth_contact_id()) AND c.location_id = challenges.location_id
    )
  );

COMMENT ON TABLE public.challenges IS 'Challenges (2026-06): operator leaderboard/collective competitions; standings computed on read.';
