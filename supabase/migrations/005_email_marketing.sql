-- ============================================================
-- 005: Email Marketing Platform
-- Postmark integration, campaigns, sequences, GDPR consent
-- ============================================================

-- ============================================================
-- CONTACT PREFERENCES (GDPR consent management)
-- Four independent consent channels, each with audit trail
-- ============================================================
CREATE TABLE contact_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  location_id UUID REFERENCES locations(id),

  -- Consent channels (true = opted in, false = opted out)
  email_marketing BOOLEAN DEFAULT TRUE,
  email_administrative BOOLEAN DEFAULT TRUE,
  whatsapp_marketing BOOLEAN DEFAULT TRUE,
  whatsapp_administrative BOOLEAN DEFAULT TRUE,

  -- Unsubscribe token for one-click unsubscribe (unique per contact)
  unsubscribe_token UUID DEFAULT gen_random_uuid() UNIQUE,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (contact_id)
);

CREATE INDEX idx_contact_prefs_contact ON contact_preferences (contact_id);
CREATE INDEX idx_contact_prefs_token ON contact_preferences (unsubscribe_token);

-- ============================================================
-- CONSENT AUDIT LOG (GDPR compliance — immutable log)
-- ============================================================
CREATE TABLE consent_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,  -- email_marketing, email_administrative, whatsapp_marketing, whatsapp_administrative
  action TEXT NOT NULL,   -- opted_in, opted_out
  source TEXT NOT NULL,   -- preference_centre, one_click_unsubscribe, manual, import, booking_form
  ip_address TEXT,
  user_agent TEXT,
  performed_by UUID REFERENCES profiles(id),  -- null if self-service
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_consent_log_contact ON consent_log (contact_id);

-- ============================================================
-- EMAIL TEMPLATES (reusable saved designs)
-- ============================================================
CREATE TABLE email_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID REFERENCES locations(id),
  name TEXT NOT NULL,
  subject TEXT,

  -- Unlayer editor JSON (for re-opening in editor)
  design_json JSONB,

  -- Compiled HTML (for sending/preview)
  html_content TEXT,

  -- Category for organising templates
  category TEXT DEFAULT 'general',  -- general, welcome, reminder, promotion, event, transactional

  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_email_templates_location ON email_templates (location_id);
CREATE INDEX idx_email_templates_category ON email_templates (category);

-- ============================================================
-- CAMPAIGNS (one-off broadcast emails)
-- ============================================================
CREATE TABLE campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID REFERENCES locations(id),
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  preview_text TEXT,           -- email preview snippet
  from_name TEXT,              -- sender display name
  from_email TEXT,             -- sender address (must be verified in Postmark)
  reply_to TEXT,

  -- Content
  design_json JSONB,           -- Unlayer JSON
  html_content TEXT,           -- compiled HTML

  -- Audience filtering (JSONB query definition)
  -- Format: { "filters": [{ "field": "lead_status", "op": "eq", "value": "member" }, ...], "logic": "and" }
  audience_filter JSONB DEFAULT '{"filters": [], "logic": "and"}'::JSONB,

  -- Status workflow
  status TEXT DEFAULT 'draft',  -- draft, scheduled, sending, sent, cancelled
  scheduled_at TIMESTAMPTZ,     -- when to send (null = manual send)
  sent_at TIMESTAMPTZ,          -- when actually sent

  -- Metrics (denormalised for fast dashboard reads)
  total_recipients INT DEFAULT 0,
  total_sent INT DEFAULT 0,
  total_delivered INT DEFAULT 0,
  total_opened INT DEFAULT 0,
  total_clicked INT DEFAULT 0,
  total_bounced INT DEFAULT 0,
  total_complained INT DEFAULT 0,
  total_unsubscribed INT DEFAULT 0,

  -- Template reference (optional — campaigns can be from scratch or from template)
  template_id UUID REFERENCES email_templates(id) ON DELETE SET NULL,

  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_campaigns_location ON campaigns (location_id);
CREATE INDEX idx_campaigns_status ON campaigns (status);
CREATE INDEX idx_campaigns_sent_at ON campaigns (sent_at);

-- ============================================================
-- CAMPAIGN RECIPIENTS (per-contact delivery tracking)
-- ============================================================
CREATE TABLE campaign_recipients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,

  -- Delivery status
  status TEXT DEFAULT 'queued',  -- queued, sent, delivered, opened, clicked, bounced, complained, unsubscribed

  -- Postmark message ID (for tracking)
  postmark_message_id TEXT,

  -- Tracking timestamps
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  opened_at TIMESTAMPTZ,
  clicked_at TIMESTAMPTZ,
  bounced_at TIMESTAMPTZ,
  bounce_type TEXT,              -- hard, soft, transient
  complained_at TIMESTAMPTZ,
  unsubscribed_at TIMESTAMPTZ,

  -- Click tracking
  clicked_links JSONB DEFAULT '[]'::JSONB,  -- [{ "url": "...", "clicked_at": "..." }]

  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (campaign_id, contact_id)
);

CREATE INDEX idx_campaign_recipients_campaign ON campaign_recipients (campaign_id);
CREATE INDEX idx_campaign_recipients_contact ON campaign_recipients (contact_id);
CREATE INDEX idx_campaign_recipients_status ON campaign_recipients (status);
CREATE INDEX idx_campaign_recipients_postmark ON campaign_recipients (postmark_message_id);

-- ============================================================
-- EMAIL SEQUENCES (automated drip campaigns)
-- ============================================================
CREATE TABLE email_sequences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID REFERENCES locations(id),
  name TEXT NOT NULL,
  description TEXT,

  -- Trigger type
  trigger_type TEXT NOT NULL DEFAULT 'manual',
  -- manual: manually enroll contacts
  -- booking_created: auto-enroll when a booking is made
  -- status_change: auto-enroll when lead_status changes to X
  -- event_reminder: auto-send reminders before events
  -- tag_added: auto-enroll when a tag/label is added

  -- Trigger configuration (depends on trigger_type)
  trigger_config JSONB DEFAULT '{}'::JSONB,
  -- booking_created: { "event_type_id": "uuid" }  (optional — specific event only)
  -- status_change: { "from": "active_trial", "to": "member" }
  -- event_reminder: { "event_type_id": "uuid", "days_before": [3, 1, 0] }
  -- tag_added: { "tag": "vip" }

  -- Audience filter (same format as campaigns — who CAN be enrolled)
  audience_filter JSONB DEFAULT '{"filters": [], "logic": "and"}'::JSONB,

  active BOOLEAN DEFAULT FALSE,  -- must be activated to auto-trigger

  -- Metrics
  total_enrolled INT DEFAULT 0,
  total_completed INT DEFAULT 0,
  total_exited INT DEFAULT 0,

  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_sequences_location ON email_sequences (location_id);
CREATE INDEX idx_sequences_trigger ON email_sequences (trigger_type);
CREATE INDEX idx_sequences_active ON email_sequences (active);

-- ============================================================
-- SEQUENCE STEPS (emails in a sequence + delays)
-- ============================================================
CREATE TABLE sequence_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id UUID NOT NULL REFERENCES email_sequences(id) ON DELETE CASCADE,
  step_order INT NOT NULL,

  -- Delay before sending (relative to previous step or enrollment)
  delay_minutes INT DEFAULT 0,       -- 0 = send immediately
  delay_type TEXT DEFAULT 'after_previous',  -- after_previous, after_enrollment

  -- Email content
  subject TEXT NOT NULL,
  design_json JSONB,
  html_content TEXT,

  -- Optional: use template instead of inline content
  template_id UUID REFERENCES email_templates(id) ON DELETE SET NULL,

  -- Step type
  step_type TEXT DEFAULT 'email',  -- email, wait, condition (future: sms, whatsapp)

  -- Metrics
  total_sent INT DEFAULT 0,
  total_opened INT DEFAULT 0,
  total_clicked INT DEFAULT 0,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_sequence_steps_sequence ON sequence_steps (sequence_id);

-- ============================================================
-- SEQUENCE ENROLLMENTS (tracking who is in what sequence)
-- ============================================================
CREATE TABLE sequence_enrollments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id UUID NOT NULL REFERENCES email_sequences(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,

  -- Current progress
  current_step_order INT DEFAULT 0,  -- 0 = not started yet
  status TEXT DEFAULT 'active',      -- active, completed, exited, paused

  -- When the next step should fire
  next_step_at TIMESTAMPTZ,

  -- Exit reason
  exit_reason TEXT,  -- completed, unsubscribed, manual_exit, filter_mismatch

  enrolled_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  exited_at TIMESTAMPTZ,

  UNIQUE (sequence_id, contact_id)
);

CREATE INDEX idx_enrollments_sequence ON sequence_enrollments (sequence_id);
CREATE INDEX idx_enrollments_contact ON sequence_enrollments (contact_id);
CREATE INDEX idx_enrollments_status ON sequence_enrollments (status);
CREATE INDEX idx_enrollments_next_step ON sequence_enrollments (next_step_at) WHERE status = 'active';

-- ============================================================
-- EMAIL SENDS (unified log — every email sent, whether campaign or sequence)
-- ============================================================
CREATE TABLE email_sends (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  location_id UUID REFERENCES locations(id),

  -- Source reference
  source_type TEXT NOT NULL,  -- campaign, sequence, transactional, event_reminder
  campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL,
  sequence_id UUID REFERENCES email_sequences(id) ON DELETE SET NULL,
  sequence_step_id UUID REFERENCES sequence_steps(id) ON DELETE SET NULL,

  -- Email details
  subject TEXT NOT NULL,
  from_email TEXT,
  to_email TEXT NOT NULL,

  -- Postmark tracking
  postmark_message_id TEXT,
  postmark_stream TEXT DEFAULT 'broadcast',  -- broadcast or outbound (transactional)

  -- Delivery status
  status TEXT DEFAULT 'sent',  -- sent, delivered, opened, clicked, bounced, complained

  sent_at TIMESTAMPTZ DEFAULT NOW(),
  delivered_at TIMESTAMPTZ,
  opened_at TIMESTAMPTZ,
  open_count INT DEFAULT 0,
  clicked_at TIMESTAMPTZ,
  click_count INT DEFAULT 0,
  bounced_at TIMESTAMPTZ,
  bounce_type TEXT,
  complained_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_email_sends_contact ON email_sends (contact_id);
CREATE INDEX idx_email_sends_location ON email_sends (location_id);
CREATE INDEX idx_email_sends_campaign ON email_sends (campaign_id);
CREATE INDEX idx_email_sends_sequence ON email_sends (sequence_id);
CREATE INDEX idx_email_sends_postmark ON email_sends (postmark_message_id);
CREATE INDEX idx_email_sends_sent_at ON email_sends (sent_at);

-- ============================================================
-- ADD EMAIL TRACKING COLUMNS TO CONTACTS
-- ============================================================
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_emailed_at TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS total_emails_sent INT DEFAULT 0;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS total_emails_opened INT DEFAULT 0;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS total_emails_clicked INT DEFAULT 0;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email_status TEXT DEFAULT 'active';  -- active, bounced, complained, unsubscribed
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}';

-- ============================================================
-- AUTO-CREATE PREFERENCES ON CONTACT INSERT
-- ============================================================
CREATE OR REPLACE FUNCTION create_contact_preferences()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO contact_preferences (contact_id, location_id)
  VALUES (NEW.id, NEW.location_id)
  ON CONFLICT (contact_id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER contact_preferences_trigger
  AFTER INSERT ON contacts
  FOR EACH ROW
  EXECUTE FUNCTION create_contact_preferences();

-- ============================================================
-- LOG EMAIL EVENTS TO CONTACT TIMELINE
-- ============================================================
CREATE OR REPLACE FUNCTION log_email_send_activity()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO activities (
    subject, type, contact_id, note, done, location_id
  ) VALUES (
    'Email sent: ' || NEW.subject,
    'email',
    NEW.contact_id,
    'Sent via ' || NEW.source_type ||
      CASE WHEN NEW.postmark_stream = 'outbound' THEN ' (transactional)' ELSE ' (marketing)' END,
    true,
    NEW.location_id
  );

  -- Update contact email stats
  UPDATE contacts SET
    last_emailed_at = NEW.sent_at,
    total_emails_sent = COALESCE(total_emails_sent, 0) + 1,
    updated_at = NOW()
  WHERE id = NEW.contact_id;

  RETURN NEW;
END;
$$;

CREATE TRIGGER email_send_activity_trigger
  AFTER INSERT ON email_sends
  FOR EACH ROW
  EXECUTE FUNCTION log_email_send_activity();

-- ============================================================
-- RLS POLICIES
-- ============================================================
ALTER TABLE contact_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE sequence_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE sequence_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_sends ENABLE ROW LEVEL SECURITY;

-- Authenticated full access (service role bypasses RLS for API routes)
CREATE POLICY "Authenticated full access" ON contact_preferences
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated full access" ON consent_log
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated full access" ON email_templates
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated full access" ON campaigns
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated full access" ON campaign_recipients
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated full access" ON email_sequences
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated full access" ON sequence_steps
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated full access" ON sequence_enrollments
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated full access" ON email_sends
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============================================================
-- UPDATED_AT TRIGGERS
-- ============================================================
CREATE TRIGGER contact_preferences_updated_at BEFORE UPDATE ON contact_preferences
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER email_templates_updated_at BEFORE UPDATE ON email_templates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER campaigns_updated_at BEFORE UPDATE ON campaigns
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER email_sequences_updated_at BEFORE UPDATE ON email_sequences
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER sequence_steps_updated_at BEFORE UPDATE ON sequence_steps
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
