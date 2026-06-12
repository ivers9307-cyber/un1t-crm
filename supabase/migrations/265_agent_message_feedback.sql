-- AGENT-QA.1 — staff thumbs on Mia's replies: the quality flywheel.
-- One row per (message, rater); re-rating upserts. Surfaced on the
-- agent analytics page so down-votes turn into knowledge/extra-rules
-- improvements.
CREATE TABLE IF NOT EXISTS public.agent_message_feedback (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id     UUID NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  channel         TEXT NOT NULL CHECK (channel IN ('whatsapp','instagram')),
  conversation_id UUID NOT NULL,
  message_id      UUID NOT NULL,
  rating          TEXT NOT NULL CHECK (rating IN ('up','down')),
  note            TEXT,
  created_by      UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (message_id, created_by)
);

CREATE INDEX IF NOT EXISTS idx_agent_feedback_location_created
  ON public.agent_message_feedback (location_id, created_at DESC);

ALTER TABLE public.agent_message_feedback ENABLE ROW LEVEL SECURITY;
CREATE POLICY "agent_feedback_location_scoped" ON public.agent_message_feedback
  FOR ALL TO authenticated
  USING (private.auth_is_in_location(location_id))
  WITH CHECK (private.auth_is_in_location(location_id));
