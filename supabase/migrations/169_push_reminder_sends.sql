-- NOTIF.1 — per-recipient dedup ledger for push reminders.
--
-- The send-push-reminders cron runs every 5 minutes and fires
-- push notifications 24h and 1h before tasks (activities.kind='task')
-- and bookings are due. Without a ledger, every cron tick that lands
-- inside the +/-5min window would re-send the same reminder.
--
-- One row per (entity_type, entity_id, recipient_id, lead_time_minutes)
-- combo. The cron inserts with ON CONFLICT DO NOTHING; the unique
-- constraint guarantees idempotency.
--
-- push_count + push_invalidated let us spot delivery issues later
-- (Expo returns DeviceNotRegistered for stale tokens — we increment
-- push_invalidated when that happens so we can clean up device_tokens
-- in a follow-up sweep).

CREATE TABLE IF NOT EXISTS public.push_reminder_sends (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('task', 'booking')),
  entity_id UUID NOT NULL,
  recipient_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  lead_time_minutes INTEGER NOT NULL CHECK (lead_time_minutes IN (60, 1440)),
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  push_count INTEGER NOT NULL DEFAULT 1,
  push_invalidated INTEGER NOT NULL DEFAULT 0,
  UNIQUE (entity_type, entity_id, recipient_id, lead_time_minutes)
);

-- Cron lookup: "have we already sent a 60-min reminder for this task
-- to anyone?" — filters by (entity_type, entity_id, lead_time_minutes).
CREATE INDEX IF NOT EXISTS idx_push_reminder_sends_lookup
  ON public.push_reminder_sends (entity_type, entity_id, lead_time_minutes);

ALTER TABLE public.push_reminder_sends ENABLE ROW LEVEL SECURITY;

-- Recipient can read their own send records. Useful for a future
-- "notification history" screen and for debugging from the user's
-- own session.
CREATE POLICY "push_reminder_sends_read_own"
  ON public.push_reminder_sends
  FOR SELECT
  TO authenticated
  USING (recipient_id = (SELECT auth.uid()));

-- Belt-and-braces: explicit deny for anon. No service-role policy
-- needed — service_role bypasses RLS, and the cron uses the
-- service-role key.
CREATE POLICY "push_reminder_sends_deny_anon"
  ON public.push_reminder_sends
  AS RESTRICTIVE
  FOR ALL
  TO anon
  USING (false)
  WITH CHECK (false);

COMMENT ON TABLE public.push_reminder_sends IS
  'NOTIF.1 — dedup ledger for task/booking push reminders. Cron inserts with ON CONFLICT DO NOTHING. recipient_id is the profile that received the push.';
