-- UN1T CRM — Initial Schema
-- Run this in Supabase SQL Editor or via supabase db push

-- ============================================================
-- PIPELINE STAGES
-- ============================================================
CREATE TABLE pipeline_stages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  display_order INT NOT NULL,
  color TEXT DEFAULT '#6B7280',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed the stages matching the current lead gen flow
INSERT INTO pipeline_stages (name, slug, display_order, color) VALUES
  ('New Lead',           'new_lead',          1, '#3B82F6'),
  ('New Lead — Social',  'new_lead_social',   2, '#8B5CF6'),
  ('Trial Active',       'trial_active',      3, '#10B981'),
  ('Conversion Ready',   'conversion_ready',  4, '#F59E0B'),
  ('Follow-up Needed',   'follow_up_needed',  5, '#EF4444'),
  ('Member',             'member',            6, '#059669'),
  ('Cold — Email Only',  'cold_email_only',   7, '#9CA3AF'),
  ('Lost Member',        'lost_member',       8, '#DC2626'),
  ('Returning Member',   'returning_member',  9, '#6366F1');

-- ============================================================
-- CONTACTS (replaces Pipedrive Persons + custom fields)
-- ============================================================
CREATE TABLE contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  email TEXT UNIQUE NOT NULL,
  phone TEXT,
  label TEXT,

  -- Fields that were Pipedrive "custom fields" — now native columns
  glofox_member_id TEXT,
  trial_credits_remaining INT DEFAULT 3,
  lead_source TEXT,                          -- booking, meta, tiktok, walkin, referral, website, whatsapp
  lead_status TEXT DEFAULT 'active_trial',   -- active_trial, cold, lost_member, member, returning
  lead_created_at TIMESTAMPTZ DEFAULT NOW(),

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_contacts_email ON contacts (email);
CREATE INDEX idx_contacts_lead_status ON contacts (lead_status);
CREATE INDEX idx_contacts_glofox_id ON contacts (glofox_member_id);

-- ============================================================
-- DEALS
-- ============================================================
CREATE TABLE deals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  stage_id UUID REFERENCES pipeline_stages(id),
  status TEXT DEFAULT 'open',   -- open, won, lost
  value DECIMAL(10,2) DEFAULT 0,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_deals_contact ON deals (contact_id);
CREATE INDEX idx_deals_stage ON deals (stage_id);
CREATE INDEX idx_deals_status ON deals (status);

-- ============================================================
-- NOTES
-- ============================================================
CREATE TABLE notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  deal_id UUID REFERENCES deals(id) ON DELETE SET NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_notes_contact ON notes (contact_id);
CREATE INDEX idx_notes_deal ON notes (deal_id);

-- ============================================================
-- ACTIVITIES
-- ============================================================
CREATE TABLE activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject TEXT NOT NULL,
  type TEXT DEFAULT 'call',   -- call, email, meeting, task
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  deal_id UUID REFERENCES deals(id) ON DELETE SET NULL,
  due_date DATE,
  due_time TIME,
  note TEXT,
  done BOOLEAN DEFAULT FALSE,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_activities_contact ON activities (contact_id);
CREATE INDEX idx_activities_due ON activities (due_date, done);

-- ============================================================
-- WEBHOOK SUBSCRIPTIONS (for n8n to register deal-update hooks)
-- ============================================================
CREATE TABLE webhook_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,    -- deal.updated, contact.created, etc.
  target_url TEXT NOT NULL,
  active BOOLEAN DEFAULT TRUE,
  secret TEXT,                 -- optional HMAC secret for verification
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- UPDATED_AT TRIGGER (auto-update timestamps)
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER contacts_updated_at BEFORE UPDATE ON contacts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER deals_updated_at BEFORE UPDATE ON deals
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER activities_updated_at BEFORE UPDATE ON activities
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- DEAL UPDATE WEBHOOK FUNCTION
-- Fires registered webhooks when a deal is updated (stage change, etc.)
-- Uses pg_net extension (available in Supabase) for async HTTP calls
-- ============================================================
CREATE OR REPLACE FUNCTION fire_deal_webhooks()
RETURNS TRIGGER AS $$
DECLARE
  sub RECORD;
  payload JSONB;
BEGIN
  -- Only fire if stage or status actually changed
  IF OLD.stage_id IS DISTINCT FROM NEW.stage_id
     OR OLD.status IS DISTINCT FROM NEW.status THEN

    payload = jsonb_build_object(
      'event', 'deal.updated',
      'current', jsonb_build_object(
        'id', NEW.id,
        'title', NEW.title,
        'contact_id', NEW.contact_id,
        'stage_id', NEW.stage_id,
        'status', NEW.status,
        'updated_at', NEW.updated_at
      ),
      'previous', jsonb_build_object(
        'stage_id', OLD.stage_id,
        'status', OLD.status
      )
    );

    FOR sub IN
      SELECT target_url FROM webhook_subscriptions
      WHERE event_type = 'deal.updated' AND active = TRUE
    LOOP
      -- pg_net is a Supabase extension for async HTTP requests
      -- If not available, replace with a notify/listen pattern
      PERFORM net.http_post(
        url := sub.target_url,
        body := payload::TEXT,
        headers := '{"Content-Type": "application/json"}'::JSONB
      );
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Enable pg_net extension (Supabase has this built in)
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

CREATE TRIGGER deal_webhook_trigger AFTER UPDATE ON deals
  FOR EACH ROW EXECUTE FUNCTION fire_deal_webhooks();

-- ============================================================
-- ROW LEVEL SECURITY (basic — open for authenticated users)
-- ============================================================
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE deals ENABLE ROW LEVEL SECURITY;
ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipeline_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_subscriptions ENABLE ROW LEVEL SECURITY;

-- Allow authenticated users full access (single-team CRM)
CREATE POLICY "Authenticated full access" ON contacts
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated full access" ON deals
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated full access" ON notes
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated full access" ON activities
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated full access" ON pipeline_stages
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated full access" ON webhook_subscriptions
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Service role (used by n8n API key) bypasses RLS automatically
