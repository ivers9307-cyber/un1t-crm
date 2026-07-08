-- EVENTS-REMINDERS.1 — pre-event reminder idempotency log. One row per
-- (registration, offset); the UNIQUE constraint is what makes the daily cron
-- safe to re-run (never double-sends a T-3d or T-1d reminder). Service-role only.

CREATE TABLE IF NOT EXISTS public.event_reminder_sends (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  registration_id  uuid NOT NULL REFERENCES public.race_registrations(id) ON DELETE CASCADE,
  reminder_offset  text NOT NULL CHECK (reminder_offset IN ('3d', '1d')),
  sent_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (registration_id, reminder_offset)
);

CREATE INDEX IF NOT EXISTS idx_event_reminder_sends_reg
  ON public.event_reminder_sends (registration_id);

ALTER TABLE public.event_reminder_sends ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.event_reminder_sends IS
  'Idempotency log for pre-event reminders (EVENTS-REMINDERS.1). UNIQUE(registration_id, reminder_offset) prevents the daily cron from double-sending. Service-role only.';

INSERT INTO public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes)
VALUES ('event-reminders', 86400, 21600, 'EVENTS-REMINDERS.1 — pre-event reminders (T-3d + T-1d)')
ON CONFLICT (name) DO NOTHING;
