-- ============================================================
-- 006: Email schema updates — align with UI components
-- ============================================================

-- Add missing columns to email_templates
ALTER TABLE email_templates ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE email_templates ADD COLUMN IF NOT EXISTS thumbnail_url TEXT;

-- Add status field to email_sequences (replacing boolean 'active')
ALTER TABLE email_sequences ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'draft';
-- Migrate existing data: active=true → 'active', active=false → 'draft'
UPDATE email_sequences SET status = CASE WHEN active = TRUE THEN 'active' ELSE 'draft' END WHERE status = 'draft' AND active IS NOT NULL;

-- Add delay_days and delay_hours to sequence_steps (more intuitive than delay_minutes)
ALTER TABLE sequence_steps ADD COLUMN IF NOT EXISTS delay_days INT DEFAULT 0;
ALTER TABLE sequence_steps ADD COLUMN IF NOT EXISTS delay_hours INT DEFAULT 0;
-- Migrate existing delay_minutes data
UPDATE sequence_steps SET
  delay_days = delay_minutes / 1440,
  delay_hours = (delay_minutes % 1440) / 60
WHERE delay_minutes > 0 AND delay_days = 0;

-- Make subject nullable on sequence_steps (new steps start empty)
ALTER TABLE sequence_steps ALTER COLUMN subject DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sequences_status ON email_sequences (status);
