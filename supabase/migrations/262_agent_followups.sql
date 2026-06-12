-- AGENT-FOLLOWUP.1 — proactive follow-up state on WhatsApp
-- conversations. stage: 0=fresh, 1=in-window nudge sent, 2=template
-- sent, 3=closed (nothing to chase). Reset to 0 by the inbound
-- webhook on every customer reply. sent_at powers the per-location
-- daily cap.
ALTER TABLE public.whatsapp_conversations
  ADD COLUMN IF NOT EXISTS agent_followup_stage smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS agent_followup_sent_at timestamptz;

INSERT INTO public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, last_ok_at)
VALUES ('agent-followups', 900, 900, NOW())
ON CONFLICT (name) DO NOTHING;
