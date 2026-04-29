-- ============================================================
-- 007: WhatsApp Business Platform — Meta Cloud API integration
-- Native WhatsApp messaging via Meta Cloud API for templates, broadcasts & inbox
-- ============================================================

-- ============================================================
-- WHATSAPP TEMPLATES (Meta-approved message templates)
-- ============================================================
CREATE TABLE whatsapp_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID REFERENCES locations(id),

  -- Template identity
  name TEXT NOT NULL,                          -- Internal name (lowercase, underscores only for Meta)
  meta_template_id TEXT,                       -- ID returned by Meta after creation
  language TEXT DEFAULT 'en',                  -- BCP 47 language code

  -- Template category (determines pricing)
  category TEXT NOT NULL DEFAULT 'MARKETING',  -- MARKETING, UTILITY, AUTHENTICATION

  -- Template structure
  -- Components array matching Meta's format:
  -- [{ "type": "HEADER", "format": "TEXT", "text": "..." },
  --  { "type": "BODY", "text": "Hello {{1}}, ..." },
  --  { "type": "FOOTER", "text": "..." },
  --  { "type": "BUTTONS", "buttons": [...] }]
  components JSONB DEFAULT '[]'::JSONB,

  -- Example values for template variables (required by Meta for approval)
  example_values JSONB DEFAULT '{}'::JSONB,

  -- Approval status from Meta
  status TEXT DEFAULT 'draft',
  -- draft: not yet submitted
  -- PENDING: submitted, awaiting Meta review
  -- APPROVED: approved and ready to send
  -- REJECTED: rejected by Meta (check rejection_reason)
  -- PAUSED: temporarily paused by Meta
  -- DISABLED: permanently disabled

  rejection_reason TEXT,

  -- Metrics
  total_sent INT DEFAULT 0,
  total_delivered INT DEFAULT 0,
  total_read INT DEFAULT 0,

  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_wa_templates_location ON whatsapp_templates (location_id);
CREATE INDEX idx_wa_templates_status ON whatsapp_templates (status);
CREATE INDEX idx_wa_templates_meta_id ON whatsapp_templates (meta_template_id);

-- ============================================================
-- WHATSAPP BROADCASTS (bulk template sends — like email campaigns)
-- ============================================================
CREATE TABLE whatsapp_broadcasts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID REFERENCES locations(id),
  name TEXT NOT NULL,

  -- Template to send
  template_id UUID REFERENCES whatsapp_templates(id),

  -- Template variable values (mapped to contact fields)
  -- e.g. { "1": "first_name", "2": "location_name" }
  variable_mapping JSONB DEFAULT '{}'::JSONB,

  -- Header media (if template has media header)
  header_media_url TEXT,

  -- Audience filter (same format as email campaigns)
  audience_filter JSONB DEFAULT '{"filters": [], "logic": "and"}'::JSONB,

  -- Status workflow
  status TEXT DEFAULT 'draft',  -- draft, sending, sent, cancelled

  -- Scheduling
  scheduled_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,

  -- Metrics
  total_recipients INT DEFAULT 0,
  total_sent INT DEFAULT 0,
  total_delivered INT DEFAULT 0,
  total_read INT DEFAULT 0,
  total_failed INT DEFAULT 0,

  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_wa_broadcasts_location ON whatsapp_broadcasts (location_id);
CREATE INDEX idx_wa_broadcasts_status ON whatsapp_broadcasts (status);

-- ============================================================
-- WHATSAPP BROADCAST RECIPIENTS (per-contact delivery tracking)
-- ============================================================
CREATE TABLE whatsapp_broadcast_recipients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  broadcast_id UUID NOT NULL REFERENCES whatsapp_broadcasts(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id),

  -- Meta message ID
  wa_message_id TEXT,

  -- Delivery status
  status TEXT DEFAULT 'pending',  -- pending, sent, delivered, read, failed
  error_message TEXT,

  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_wa_broadcast_recip_broadcast ON whatsapp_broadcast_recipients (broadcast_id);
CREATE INDEX idx_wa_broadcast_recip_contact ON whatsapp_broadcast_recipients (contact_id);
CREATE INDEX idx_wa_broadcast_recip_msg ON whatsapp_broadcast_recipients (wa_message_id);

-- ============================================================
-- WHATSAPP CONVERSATIONS (tracks 24h messaging windows)
-- ============================================================
CREATE TABLE whatsapp_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID REFERENCES locations(id),
  contact_id UUID NOT NULL REFERENCES contacts(id),

  -- The contact's WhatsApp number (E.164 format)
  wa_phone TEXT NOT NULL,

  -- 24-hour window tracking
  -- Window opens when contact sends a message, expires 24h later
  window_open_at TIMESTAMPTZ,
  window_expires_at TIMESTAMPTZ,

  -- Conversation state
  status TEXT DEFAULT 'active',  -- active, expired, blocked

  -- Last message tracking
  last_message_at TIMESTAMPTZ,
  last_message_direction TEXT,  -- inbound, outbound
  last_message_preview TEXT,    -- First ~100 chars for list view

  -- Unread count (inbound messages not yet viewed)
  unread_count INT DEFAULT 0,

  -- Assigned staff member
  assigned_to UUID REFERENCES profiles(id),

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(location_id, contact_id)
);

CREATE INDEX idx_wa_conv_location ON whatsapp_conversations (location_id);
CREATE INDEX idx_wa_conv_contact ON whatsapp_conversations (contact_id);
CREATE INDEX idx_wa_conv_phone ON whatsapp_conversations (wa_phone);
CREATE INDEX idx_wa_conv_last_msg ON whatsapp_conversations (last_message_at DESC);

-- ============================================================
-- WHATSAPP MESSAGES (full message log — both directions)
-- ============================================================
CREATE TABLE whatsapp_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES whatsapp_conversations(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id),
  location_id UUID REFERENCES locations(id),

  -- Message identity
  wa_message_id TEXT,                  -- Meta's message ID
  direction TEXT NOT NULL,             -- inbound, outbound

  -- Content
  message_type TEXT DEFAULT 'text',    -- text, template, image, video, document, audio, location, contacts, interactive
  body TEXT,                           -- Text content or caption
  media_url TEXT,                      -- Media URL (images, videos, docs)
  media_mime_type TEXT,
  template_name TEXT,                  -- If sent as template
  template_variables JSONB,            -- Variables used in template

  -- Delivery status (outbound only)
  status TEXT DEFAULT 'pending',       -- pending, sent, delivered, read, failed
  error_code TEXT,
  error_message TEXT,

  -- Sender info
  sent_by UUID REFERENCES profiles(id),  -- Staff member who sent (outbound only)

  -- Timestamps
  sent_at TIMESTAMPTZ DEFAULT NOW(),
  delivered_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,

  -- If this message is part of a broadcast
  broadcast_id UUID REFERENCES whatsapp_broadcasts(id),

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_wa_messages_conv ON whatsapp_messages (conversation_id, created_at);
CREATE INDEX idx_wa_messages_contact ON whatsapp_messages (contact_id);
CREATE INDEX idx_wa_messages_wa_id ON whatsapp_messages (wa_message_id);
CREATE INDEX idx_wa_messages_direction ON whatsapp_messages (direction, created_at DESC);

-- ============================================================
-- CONTACT FIELDS for WhatsApp
-- ============================================================
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS wa_phone TEXT;              -- WhatsApp number (E.164)
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS wa_status TEXT DEFAULT 'active';  -- active, blocked, opted_out
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_wa_message_at TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS total_wa_sent INT DEFAULT 0;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS total_wa_received INT DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_contacts_wa_phone ON contacts (wa_phone);

-- ============================================================
-- TRIGGERS
-- ============================================================

-- Auto-update updated_at
CREATE TRIGGER set_wa_templates_updated_at BEFORE UPDATE ON whatsapp_templates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER set_wa_broadcasts_updated_at BEFORE UPDATE ON whatsapp_broadcasts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER set_wa_conversations_updated_at BEFORE UPDATE ON whatsapp_conversations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Log outbound WhatsApp messages to contact timeline
CREATE OR REPLACE FUNCTION log_wa_message_to_timeline()
RETURNS TRIGGER AS $$
BEGIN
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

    -- Update contact stats
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

    -- Update contact stats
    UPDATE contacts SET
      last_wa_message_at = NEW.sent_at,
      total_wa_received = total_wa_received + 1
    WHERE id = NEW.contact_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_wa_message_timeline
  AFTER INSERT ON whatsapp_messages
  FOR EACH ROW EXECUTE FUNCTION log_wa_message_to_timeline();

-- ============================================================
-- RLS POLICIES
-- ============================================================
ALTER TABLE whatsapp_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_broadcasts ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_broadcast_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_messages ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS (used by API routes with service key)
CREATE POLICY "Service role full access" ON whatsapp_templates FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON whatsapp_broadcasts FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON whatsapp_broadcast_recipients FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON whatsapp_conversations FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON whatsapp_messages FOR ALL USING (true) WITH CHECK (true);
