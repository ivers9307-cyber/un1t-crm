-- ============================================================
-- 094: GDPR-friendly contact delete with WhatsApp history
--
-- Background. Three WhatsApp tables had ON DELETE NO ACTION on
-- their contacts.id FK, which made deleting a contact with WhatsApp
-- history impossible — the operator was forced to merge first or
-- give up. That's structurally wrong for GDPR right-to-erasure:
-- the contact's PII has to be removable on request, even when there's
-- a chat thread.
--
-- New shape. The conversation thread is preserved (operator-side
-- audit, regulatory record-keeping) but the rows are anonymised by
-- a code-side scrub (`redactWhatsAppForContact()` in
-- src/lib/contact-merge.js) called BEFORE the contact row is
-- deleted. That scrub strips wa_phone, wa_profile_name, message
-- body, media_url, template_variables. The FK rule then handles the
-- contact_id link automatically:
--
--   whatsapp_conversations.contact_id        ON DELETE SET NULL
--   whatsapp_messages.contact_id             ON DELETE SET NULL
--   whatsapp_broadcast_recipients.contact_id ON DELETE CASCADE
--
-- Why CASCADE on broadcast_recipients: it's a per-(broadcast,
-- recipient) send-status row. Once the recipient is gone the row's
-- only data — sent/delivered/read timestamps, error code — is
-- meaningless on its own. The parent broadcast row stays. Audit at
-- the broadcast level is via the aggregated counts on the
-- broadcast row itself, not per-recipient timestamps.
--
-- Why SET NULL on conversations + messages: the conversation thread
-- and per-message audit (timestamps, status, message_type) are
-- worth keeping. The PII goes via the scrub; the row stays.
--
-- wa_phone NOT NULL is dropped on whatsapp_conversations because
-- the scrub needs to write NULL there. The unique index that
-- enforced one-conversation-per-(location, phone) is replaced with
-- a partial index that only constrains non-null phones — redacted
-- rows can stack without collision.
-- ============================================================

BEGIN;

-- whatsapp_conversations: drop NOT NULL on wa_phone, replace the
-- UNIQUE index with a partial one (was UNIQUE(location_id, wa_phone),
-- now UNIQUE(location_id, wa_phone) WHERE wa_phone IS NOT NULL).
ALTER TABLE whatsapp_conversations
  ALTER COLUMN wa_phone DROP NOT NULL;
DROP INDEX IF EXISTS idx_wa_conv_location_phone;
CREATE UNIQUE INDEX idx_wa_conv_location_phone
  ON whatsapp_conversations (location_id, wa_phone)
  WHERE wa_phone IS NOT NULL;

-- whatsapp_conversations.contact_id → ON DELETE SET NULL
ALTER TABLE whatsapp_conversations
  DROP CONSTRAINT IF EXISTS whatsapp_conversations_contact_id_fkey;
ALTER TABLE whatsapp_conversations
  ADD CONSTRAINT whatsapp_conversations_contact_id_fkey
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL;

-- whatsapp_messages.contact_id → ON DELETE SET NULL
ALTER TABLE whatsapp_messages
  DROP CONSTRAINT IF EXISTS whatsapp_messages_contact_id_fkey;
ALTER TABLE whatsapp_messages
  ADD CONSTRAINT whatsapp_messages_contact_id_fkey
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL;

-- whatsapp_broadcast_recipients.contact_id → ON DELETE CASCADE
-- (column is NOT NULL; CASCADE is the only sane delete-rule that
-- doesn't violate the constraint when the parent contact goes away).
ALTER TABLE whatsapp_broadcast_recipients
  DROP CONSTRAINT IF EXISTS whatsapp_broadcast_recipients_contact_id_fkey;
ALTER TABLE whatsapp_broadcast_recipients
  ADD CONSTRAINT whatsapp_broadcast_recipients_contact_id_fkey
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE;

COMMENT ON COLUMN whatsapp_conversations.wa_phone IS
  'Mig 094: nullable so a GDPR right-to-erasure can scrub it while keeping the conversation row for audit. Partial UNIQUE index (location_id, wa_phone) WHERE wa_phone IS NOT NULL means redacted rows do not collide.';

COMMIT;
