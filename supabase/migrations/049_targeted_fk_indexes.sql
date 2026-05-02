-- ============================================================
-- 049: Targeted FK indexes
--
-- The Supabase advisor flagged 40 unindexed foreign keys. Most
-- of those (29) are `*_created_by_fkey` / `*_reviewed_by_fkey`
-- / `*_uploaded_by_fkey` audit columns — they exist for FK
-- integrity, never as SELECT predicates. Indexing them costs
-- write amplification with no read benefit.
--
-- This migration adds indexes ONLY on FKs that the app actually
-- queries by:
--
--   activities(deal_id)              — pipeline timeline
--   activities(location_id)          — location-scoped queries
--   notes(location_id)               — notes(deal_id) is already
--                                       indexed (idx_notes_deal)
--   pipeline_stages(location_id)     — every Kanban load
--   email_sends(sequence_step_id)    — sequence reporting
--   whatsapp_messages(broadcast_id)  — broadcast reporting
--   whatsapp_messages(location_id)   — WAInbox
--   contact_preferences(location_id) — preferences page
--   event_types(reminder_email_template_id)    — reminder runner
--   event_types(reminder_whatsapp_template_id) — reminder runner
--
-- The reminder template indexes are partial — only ~1% of
-- event_types rows will have a reminder template attached, so
-- a partial index is much cheaper to maintain than a full one.
-- ============================================================

BEGIN;

CREATE INDEX IF NOT EXISTS idx_activities_deal
  ON public.activities (deal_id);

CREATE INDEX IF NOT EXISTS idx_activities_location
  ON public.activities (location_id);

CREATE INDEX IF NOT EXISTS idx_notes_location
  ON public.notes (location_id);

CREATE INDEX IF NOT EXISTS idx_pipeline_stages_location
  ON public.pipeline_stages (location_id);

CREATE INDEX IF NOT EXISTS idx_email_sends_sequence_step
  ON public.email_sends (sequence_step_id)
  WHERE sequence_step_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_wa_messages_broadcast
  ON public.whatsapp_messages (broadcast_id)
  WHERE broadcast_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_wa_messages_location
  ON public.whatsapp_messages (location_id);

CREATE INDEX IF NOT EXISTS idx_contact_preferences_location
  ON public.contact_preferences (location_id);

CREATE INDEX IF NOT EXISTS idx_event_types_reminder_email_template
  ON public.event_types (reminder_email_template_id)
  WHERE reminder_email_template_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_event_types_reminder_wa_template
  ON public.event_types (reminder_whatsapp_template_id)
  WHERE reminder_whatsapp_template_id IS NOT NULL;

COMMIT;
