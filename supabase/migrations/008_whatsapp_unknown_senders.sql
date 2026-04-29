-- ============================================================
-- 008: WhatsApp unknown senders + contacts.email nullable
--
-- 1. Make contacts.email nullable (WhatsApp-only contacts may not have email)
-- 2. Make contact_id nullable on whatsapp_conversations and whatsapp_messages
--    so unknown senders can have conversations without being added to contacts
-- 3. Add wa_profile_name to conversations for display before contact is linked
-- 4. Update timeline trigger to skip when contact_id is null
-- ============================================================

-- ============================================================
-- 1. CONTACTS: Make email nullable
-- ============================================================

ALTER TABLE contacts ALTER COLUMN email DROP NOT NULL;

-- Drop existing unique constraint on email
ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_email_key;

-- Re-add unique constraint that allows NULLs
CREATE UNIQUE INDEX IF NOT EXISTS contacts_email_unique
  ON contacts (email) WHERE email IS NOT NULL;

-- ============================================================
-- 2. WHATSAPP_CONVERSATIONS: Make contact_id nullable, add profile name
-- ============================================================

-- Make contact_id nullable
ALTER TABLE whatsapp_conversations ALTER COLUMN contact_id DROP NOT NULL;

-- Drop the old unique constraint on (location_id, contact_id)
ALTER TABLE whatsapp_conversations DROP CONSTRAINT IF EXISTS whatsapp_conversations_location_id_contact_id_key;

-- Add unique constraint on (location_id, wa_phone) instead
-- This ensures one conversation per phone number per location
CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_conv_location_phone
  ON whatsapp_conversations (location_id, wa_phone);

-- Add WhatsApp profile name for unknown senders (shown in inbox before they're added as contacts)
ALTER TABLE whatsapp_conversations ADD COLUMN IF NOT EXISTS wa_profile_name TEXT;

-- ============================================================
-- 3. WHATSAPP_MESSAGES: Make contact_id nullable
-- ============================================================

ALTER TABLE whatsapp_messages ALTER COLUMN contact_id DROP NOT NULL;

-- ============================================================
-- 4. Update timeline trigger to skip when contact_id is null
-- ============================================================

CREATE OR REPLACE FUNCTION log_wa_message_to_timeline()
RETURNS TRIGGER AS $$
BEGIN
  -- Skip timeline logging if no contact is linked (unknown sender)
  IF NEW.contact_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.direction = 'outbound' THEN
    INSERT INTO activities (
      contact_id, location_id, type, description, created_at
    ) VALUES (
      NEW.contact_id,
      NEW.location_id,
      'whatsapp_sent',
      COALESCE('WhatsApp: ' || LEFT(NEW.body, 100), 'WhatsApp template: ' || NEW.template_name),
      NEW.created_at
    );

    UPDATE contacts SET
      last_wa_message_at = NEW.sent_at,
      total_wa_sent = total_wa_sent + 1
    WHERE id = NEW.contact_id;
  ELSIF NEW.direction = 'inbound' THEN
    INSERT INTO activities (
      contact_id, location_id, type, description, created_at
    ) VALUES (
      NEW.contact_id,
      NEW.location_id,
      'whatsapp_received',
      'WhatsApp: ' || LEFT(NEW.body, 100),
      NEW.created_at
    );

    UPDATE contacts SET
      last_wa_message_at = NEW.sent_at,
      total_wa_received = total_wa_received + 1
    WHERE id = NEW.contact_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
