-- 296: Engagement loop — idempotency log for goal-completion + streak-at-risk
-- notifications. Achievements reuse contact_achievements.notified_at; this table
-- covers the two periodic notifications. Service-role writes (endSession + cron);
-- customers read their own (cheap seed for a future in-app feed).
CREATE TABLE IF NOT EXISTS public.customer_engagement_nudges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('streak_at_risk','goal_complete')),
  dedup_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contact_id, type, dedup_key)
);
CREATE INDEX IF NOT EXISTS idx_customer_engagement_nudges_contact
  ON public.customer_engagement_nudges(contact_id, type);

ALTER TABLE public.customer_engagement_nudges ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Customers read own engagement nudges"
  ON public.customer_engagement_nudges FOR SELECT TO public
  USING (contact_id = (SELECT private.auth_contact_id()));

CREATE POLICY "Staff read engagement nudges at their locations"
  ON public.customer_engagement_nudges FOR SELECT TO public
  USING (
    (SELECT private.auth_is_master())
    OR EXISTS (
      SELECT 1 FROM public.contacts c
      WHERE c.id = customer_engagement_nudges.contact_id
        AND private.auth_is_in_location(c.location_id)
    )
  );

COMMENT ON TABLE public.customer_engagement_nudges IS
  'Engagement loop (2026-06): idempotency log for goal_complete + streak_at_risk pushes. Service-role write, customer self-read.';

-- Heartbeat for the streak-at-risk cron (daily 11:00 UTC).
INSERT INTO public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes)
VALUES ('notify-streak-at-risk', 86400, 7200, 'Daily 11:00 UTC — streak-at-risk push nudge. 2h grace.')
ON CONFLICT (name) DO NOTHING;
