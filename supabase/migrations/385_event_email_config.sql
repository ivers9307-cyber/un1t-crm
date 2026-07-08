-- EVENTS-EMAILCFG.1 — per-event email configuration. Each race_event can style
-- its signup/confirmation + reminder emails: a subject + intro copy (dropped
-- into the shared branded shell, which also picks up the event's existing
-- accent_hex + hero_image_url), OR an advanced full-HTML template
-- (email_templates FK, mirroring event_types) that overrides the shell.
-- All nullable → NULL falls back to today's default copy/look (behaviour-
-- preserving). Merge tags ({{event_name}}, {{team_name}}, {{when}}, …) render
-- in the copy + template HTML.

ALTER TABLE public.race_events
  ADD COLUMN IF NOT EXISTS confirmation_email_subject     text,
  ADD COLUMN IF NOT EXISTS confirmation_email_intro       text,
  ADD COLUMN IF NOT EXISTS reminder_email_subject         text,
  ADD COLUMN IF NOT EXISTS reminder_email_intro           text,
  ADD COLUMN IF NOT EXISTS confirmation_email_template_id uuid REFERENCES public.email_templates(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reminder_email_template_id     uuid REFERENCES public.email_templates(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.race_events.confirmation_email_intro IS
  'EVENTS-EMAILCFG.1 — operator intro/body copy for the signup confirmation email (merge tags allowed). NULL = default copy. Ignored when confirmation_email_template_id is set.';
COMMENT ON COLUMN public.race_events.confirmation_email_template_id IS
  'EVENTS-EMAILCFG.1 — advanced: a full email_templates row that overrides the shared shell for the confirmation email.';
