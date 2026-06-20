-- 297: Monthly target + tiers — durable record of months a member hit the gym's
-- monthly UN1T-Points target. Only HIT months get a row (no demotion). months_hit
-- = count(rows); tier derived in code. `target` snapshots the gym target at bank
-- time so later target edits never retroactively un-hit a month. Service-role write
-- (endSession); customer self-read + staff-at-location read.
CREATE TABLE IF NOT EXISTS public.member_monthly_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  period_month text NOT NULL,          -- 'YYYY-MM' (UTC)
  points integer NOT NULL,
  target integer NOT NULL,
  banked_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contact_id, period_month)
);
CREATE INDEX IF NOT EXISTS idx_member_monthly_targets_contact ON public.member_monthly_targets(contact_id);

ALTER TABLE public.member_monthly_targets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Customers read own monthly targets"
  ON public.member_monthly_targets FOR SELECT TO public
  USING (contact_id = (SELECT private.auth_contact_id()));

CREATE POLICY "Staff read monthly targets at their locations"
  ON public.member_monthly_targets FOR SELECT TO public
  USING (
    (SELECT private.auth_is_master())
    OR EXISTS (
      SELECT 1 FROM public.contacts c
      WHERE c.id = member_monthly_targets.contact_id
        AND private.auth_is_in_location(c.location_id)
    )
  );

COMMENT ON TABLE public.member_monthly_targets IS
  'Monthly target + tiers (2026-06): one row per member per month they hit the gym points target. Tier = count(rows). Service-role write, customer self-read.';
