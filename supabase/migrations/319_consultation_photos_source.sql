-- ============================================================
-- 319: consultation_photos.source — coach vs member upload (P2-2)
--
-- Adds a discriminator so the coach can tell member-uploaded progress pics
-- apart from coach-taken ones on the CRM profile. Default 'coach' covers
-- every existing row + all staff uploads (the staff upload route inserts no
-- source). The champ-app member-upload route (a later phase) sets 'member'.
--
-- Members read their own photos (with server-minted signed URLs, since the
-- bucket is private) via the customer-authed GET /api/consultation-photos/me.
-- ============================================================

ALTER TABLE consultation_photos ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'coach';

ALTER TABLE consultation_photos DROP CONSTRAINT IF EXISTS consultation_photos_source_check;
ALTER TABLE consultation_photos ADD CONSTRAINT consultation_photos_source_check
  CHECK (source IN ('coach', 'member'));

COMMENT ON COLUMN consultation_photos.source IS
  'Who uploaded the photo: coach (staff upload, default — covers all existing rows) or member (self-upload from the champ-app, mig 319). Lets the coach spot member-uploaded progress pics on the CRM profile.';
