-- 117_contact_goals.sql
--
-- Phase 4: weekly goals. Members set a target ("200 UN1T points/week",
-- "3 classes/week"); the dashboard widget shows their progress
-- against it for the current period.
--
-- Design choice: do NOT denormalise current_value. Progress is
-- computed at read time from heart_rate_sessions over the current
-- week boundary. Cheap (small per-contact result set), avoids a
-- weekly reset cron, and keeps the row small enough that we don't
-- need to think about race conditions when sessions land.
--
-- "kind" is constrained to a small enum here. New kinds (e.g.
-- monthly_z4_minutes) are a one-line code addition + check
-- constraint update.

BEGIN;

CREATE TABLE IF NOT EXISTS public.contact_goals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id    uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN (
                  'weekly_points', 'weekly_classes',
                  'monthly_points', 'monthly_classes'
                )),
  target_value  int NOT NULL CHECK (target_value > 0),
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz,
  -- A contact has at most one active goal of each kind.
  UNIQUE (contact_id, kind, archived_at)
);

CREATE INDEX IF NOT EXISTS idx_contact_goals_contact_active
  ON public.contact_goals (contact_id) WHERE is_active AND archived_at IS NULL;

CREATE OR REPLACE FUNCTION public.touch_contact_goals_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END;
$$;
DROP TRIGGER IF EXISTS trg_contact_goals_touch ON public.contact_goals;
CREATE TRIGGER trg_contact_goals_touch
  BEFORE UPDATE ON public.contact_goals
  FOR EACH ROW EXECUTE FUNCTION public.touch_contact_goals_updated_at();

ALTER TABLE public.contact_goals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Customers manage own goals"
  ON public.contact_goals FOR ALL TO public
  USING (contact_id = private.auth_contact_id())
  WITH CHECK (contact_id = private.auth_contact_id());

CREATE POLICY "Staff read goals at their locations"
  ON public.contact_goals FOR SELECT TO public
  USING (
    private.auth_is_master()
    OR EXISTS (
      SELECT 1 FROM public.contacts c
      WHERE c.id = contact_goals.contact_id
        AND private.auth_is_in_location(c.location_id)
    )
  );

COMMIT;
