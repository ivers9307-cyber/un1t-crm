-- 255 — UIX-P1 (unified inbox): operator-facing "resolved" state on
-- conversations.
--
-- The unified inbox's queue is "Needs reply" by default: a
-- conversation whose last message is inbound AND which nobody has
-- resolved. Resolve is a lightweight operator action (a timestamp,
-- not a status-enum change — whatsapp_conversations.status keeps its
-- active/expired/blocked lifecycle semantics untouched). A new
-- INBOUND message auto-clears resolved_at in the webhooks so a
-- "done" thread that gets a fresh customer reply returns to the
-- queue.
--
-- Writes flow through the existing per-channel /api conversation
-- routes (service role + assertLocationAccess) — instagram_conversations
-- is deny-write for the authenticated role by design (mig 231), so no
-- RLS changes are needed here.

ALTER TABLE whatsapp_conversations
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

ALTER TABLE instagram_conversations
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

COMMENT ON COLUMN whatsapp_conversations.resolved_at IS
  'UIX-P1: operator marked this thread handled. NULL = in the Needs-reply queue (when last_message_direction = inbound). Auto-cleared by the webhook on new inbound.';

COMMENT ON COLUMN instagram_conversations.resolved_at IS
  'UIX-P1: operator marked this thread handled. NULL = in the Needs-reply queue (when last_message_direction = inbound). Auto-cleared by the webhook on new inbound.';
