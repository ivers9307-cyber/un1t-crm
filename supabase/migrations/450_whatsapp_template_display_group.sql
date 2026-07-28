-- ============================================================
-- 450: WhatsApp template display groups
-- Operator-defined grouping label for template pickers (inbox
-- composer, templates list, mobile sheet). Local-only — never
-- sent to or synced from Meta, so ?sync=true leaves it intact.
-- NULL/empty = ungrouped ("Ungrouped" bucket, rendered last).
-- ============================================================

ALTER TABLE whatsapp_templates
  ADD COLUMN IF NOT EXISTS display_group TEXT;

COMMENT ON COLUMN whatsapp_templates.display_group IS
  'Operator-defined picker grouping label (mig 450). Local-only, not a Meta field. NULL = ungrouped.';
