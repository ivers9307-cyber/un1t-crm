-- Phase 2b — extend sequence_steps to support WhatsApp template
-- steps. The step_type column already accepts 'whatsapp' (mig 005
-- comment); this adds the columns the runner needs to actually
-- send.

ALTER TABLE sequence_steps
  ADD COLUMN IF NOT EXISTS whatsapp_template_id      UUID REFERENCES whatsapp_templates(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS whatsapp_variables        JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS whatsapp_header_media_url TEXT;

COMMENT ON COLUMN sequence_steps.whatsapp_template_id IS
  'For step_type=whatsapp — references whatsapp_templates row (must be APPROVED).';
COMMENT ON COLUMN sequence_steps.whatsapp_variables IS
  'Variable mapping for the chosen template, same shape as whatsapp_broadcasts.variable_mapping. Map of "1","2",... → contact field name (first_name, email, phone) OR a literal string.';

CREATE INDEX IF NOT EXISTS sequence_steps_whatsapp_template_idx
  ON sequence_steps(whatsapp_template_id) WHERE whatsapp_template_id IS NOT NULL;
