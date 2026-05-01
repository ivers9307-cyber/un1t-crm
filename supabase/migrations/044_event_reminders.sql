-- Per-event reminder configuration. Each event_type can opt-in to a
-- single-shot reminder sent N minutes before each booking's start time,
-- delivered as either an email or a WhatsApp utility template.
--
-- This complements (doesn't replace) the sequence-based event_reminder
-- trigger added the previous round. That stays for the rare case
-- where a multi-step reminder flow is needed (e.g. 24h + 2h + day-of).
-- This is the simple single-message path that lives WITH the event so
-- operators don't need to author a sequence to get the most common case.
--
-- Dedup: each booking row gets a `reminder_sent_at` stamp so the cron
-- never re-sends. Indexed for the runner's "find bookings still
-- needing a reminder" query.

ALTER TABLE event_types
  ADD COLUMN IF NOT EXISTS reminder_enabled              BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS reminder_minutes_before       INT,
  ADD COLUMN IF NOT EXISTS reminder_channel              TEXT,
  ADD COLUMN IF NOT EXISTS reminder_email_template_id    UUID REFERENCES email_templates(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reminder_email_subject        TEXT,
  ADD COLUMN IF NOT EXISTS reminder_whatsapp_template_id UUID REFERENCES whatsapp_templates(id) ON DELETE SET NULL;

ALTER TABLE event_types
  ADD CONSTRAINT IF NOT EXISTS reminder_channel_check
  CHECK (reminder_channel IS NULL OR reminder_channel IN ('email', 'whatsapp'));

COMMENT ON COLUMN event_types.reminder_enabled IS
  'When true, the cron sends a single reminder N minutes before each booking start.';
COMMENT ON COLUMN event_types.reminder_minutes_before IS
  'Minutes before booking start_time to send the reminder. NULL = disabled.';
COMMENT ON COLUMN event_types.reminder_channel IS
  'Channel for the reminder. One of: email, whatsapp.';
COMMENT ON COLUMN event_types.reminder_email_template_id IS
  'Template to render for email reminders. Subject falls back to reminder_email_subject if the template subject is empty.';
COMMENT ON COLUMN event_types.reminder_whatsapp_template_id IS
  'Approved WhatsApp utility template. Body variables are filled with merge tags (contact name, event name, time).';

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ;

-- Partial index used by the reminder runner to find bookings that
-- still need a reminder (the vast majority of historical bookings
-- already have reminder_sent_at set, so the partial index keeps the
-- working set tiny).
CREATE INDEX IF NOT EXISTS idx_bookings_reminder_pending
  ON bookings (event_type_id, booking_date)
  WHERE reminder_sent_at IS NULL AND status = 'confirmed';

COMMENT ON COLUMN bookings.reminder_sent_at IS
  'Set by the per-event reminder runner once a reminder has been delivered. Not set if event_types.reminder_enabled is false.';
