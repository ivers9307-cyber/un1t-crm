-- 725_wa_conversation_studio_resolution.sql
-- WASTUDIOPICK.1 — how an unknown WhatsApp sender's studio was decided
-- (docs/superpowers/specs/2026-10-15-wa-new-sender-studio-design.md, R6).
-- { status: 'asked'|'decided'|'unresolved', by?: 'ad'|'reply'|'ai'|'picker'|'staff',
--   location_id?, reason?, at }. NULL = never considered. 'asked' is the only
-- non-final status. Written only by service-role code (the webhook's
-- resolver and the Move to studio route).
-- column-grant: whatsapp_conversations carries table-level SELECT for
-- authenticated (mig 661), so the inbox realtime reads this column like the
-- rest of the row; no write privilege changes.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE public.whatsapp_conversations ADD COLUMN IF NOT EXISTS studio_resolution jsonb;
COMMENT ON COLUMN public.whatsapp_conversations.studio_resolution IS
  'WASTUDIOPICK.1 (mig 725): how an unknown sender''s studio was decided; NULL = never considered.';
COMMIT;
