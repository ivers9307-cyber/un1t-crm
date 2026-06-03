-- ============================================================
-- 241: drop the deprecated event_types.reminder_* columns
-- ============================================================
--
-- WHY
-- ───
-- The single-shot per-event reminder model on event_types.reminder_*
-- was superseded by the multi-row event_type_reminders table in mig
-- 076 (1..N reminders per event_type, each with its own offset +
-- channel set). Per the codebase's two-stage deprecation convention,
-- mig 076 left the old columns in place + COMMENT'd as deprecated; the
-- runner, the EventForm, and every writer moved to event_type_reminders.
-- This is the delayed cleanup that drops the now-dead columns.
--
-- VERIFIED SAFE before writing this (2026-06-03):
--   - Zero readers/writers across src/ + mobile/ + shared/ for all 7
--     columns (reminder_enabled, reminder_minutes_before,
--     reminder_channel, reminder_email_subject, reminder_email_template_id,
--     reminder_sms_body, reminder_whatsapp_template_id).
--   - No function / view / trigger in public or private references any of
--     them (checked pg_proc.prosrc + pg_get_viewdef).
--   - event_type_reminders is the live source; 0 event_types rows have
--     reminder_enabled = true, so there is no live data on the old shape.
--
-- DROP also removes the mig 074 CHECK constraint on reminder_channel
-- automatically. Forward-only; irreversible without a restore — but the
-- columns hold no live data.

ALTER TABLE event_types
  DROP COLUMN IF EXISTS reminder_enabled,
  DROP COLUMN IF EXISTS reminder_minutes_before,
  DROP COLUMN IF EXISTS reminder_channel,
  DROP COLUMN IF EXISTS reminder_email_subject,
  DROP COLUMN IF EXISTS reminder_email_template_id,
  DROP COLUMN IF EXISTS reminder_sms_body,
  DROP COLUMN IF EXISTS reminder_whatsapp_template_id;
