-- ============================================================
-- 087: sequence_steps.config + new step_type values
--
-- Tier 1B of the sequences expansion. Three new step types:
--   - 'apply_tag'      — applies a contact_tags row to the
--                        contact (mig 085 retargeting tag)
--   - 'update_field'   — sets contacts.lead_status (or label)
--   - 'internal_task'  — creates an activity row (kind='task')
--                        assigned to a staff user
--
-- Config for each lives in a new JSONB column rather than a
-- bloat of typed columns — these step types' configs are small
-- (1-3 fields) and they're niche enough that a dedicated column
-- per attribute would clutter the table.
--
-- Existing email / wait / whatsapp / sms steps don't need this
-- column — they have their typed columns already (email_template_id,
-- whatsapp_template_id, sms_body, etc).
-- ============================================================

BEGIN;

ALTER TABLE sequence_steps
  ADD COLUMN IF NOT EXISTS config JSONB DEFAULT '{}'::jsonb;

COMMENT ON COLUMN sequence_steps.config IS
  'Free-form config for non-message step types (mig 087). Schema by step_type: apply_tag → { tag }; update_field → { field, value }; internal_task → { subject, note, assignee_role, assignee_user_id, due_offset_minutes }. Existing message step types (email/whatsapp/sms) ignore this column.';

COMMIT;
