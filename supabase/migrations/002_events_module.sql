-- UN1T CRM — Events & Booking Module
-- Run this in Supabase SQL Editor after 001_initial_schema.sql

-- ============================================================
-- EVENT TYPES (each event type = a bookable service)
-- e.g. "Free Consultation", "Trial Class", "PT Assessment"
-- ============================================================
CREATE TABLE event_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  duration_minutes INT NOT NULL DEFAULT 30,
  color TEXT DEFAULT '#3B82F6',
  active BOOLEAN DEFAULT TRUE,

  -- Availability: business hours per day (JSONB)
  -- Format: { "mon": { "start": "09:00", "end": "18:00" }, "tue": { ... }, ... }
  -- Null day = not available that day
  availability JSONB NOT NULL DEFAULT '{
    "mon": { "start": "09:00", "end": "18:00" },
    "tue": { "start": "09:00", "end": "18:00" },
    "wed": { "start": "09:00", "end": "18:00" },
    "thu": { "start": "09:00", "end": "18:00" },
    "fri": { "start": "09:00", "end": "18:00" },
    "sat": null,
    "sun": null
  }'::JSONB,

  -- Buffer time between appointments (minutes)
  buffer_minutes INT DEFAULT 0,

  -- How far in advance can someone book (days)
  max_advance_days INT DEFAULT 30,

  -- Custom form fields (JSONB array)
  -- Format: [{ "id": "uuid", "label": "Experience level", "type": "dropdown", "options": ["Beginner", "Intermediate", "Advanced"], "required": true }, ...]
  -- Supported types: text, textarea, dropdown, checkbox, radio
  custom_fields JSONB DEFAULT '[]'::JSONB,

  -- Webhook URL to fire when a booking is made (for n8n integration)
  webhook_url TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_event_types_slug ON event_types (slug);
CREATE INDEX idx_event_types_active ON event_types (active);

-- ============================================================
-- BLOCKED TIMES (manual overrides — holidays, breaks, etc.)
-- ============================================================
CREATE TABLE blocked_times (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type_id UUID REFERENCES event_types(id) ON DELETE CASCADE,
  blocked_date DATE NOT NULL,
  start_time TIME,          -- null = entire day blocked
  end_time TIME,            -- null = entire day blocked
  reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_blocked_times_event ON blocked_times (event_type_id, blocked_date);

-- ============================================================
-- BOOKINGS
-- ============================================================
CREATE TABLE bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type_id UUID REFERENCES event_types(id) ON DELETE SET NULL,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,

  -- Booking details
  booking_date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  status TEXT DEFAULT 'confirmed',  -- confirmed, cancelled, completed, no_show

  -- Customer details (captured at booking time, before contact is created)
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  customer_phone TEXT,

  -- Custom field responses (JSONB)
  -- Format: { "field_id": "value", ... }
  custom_responses JSONB DEFAULT '{}'::JSONB,

  -- Metadata
  source TEXT DEFAULT 'booking_page',  -- booking_page, manual, embed
  notes TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_bookings_event ON bookings (event_type_id);
CREATE INDEX idx_bookings_contact ON bookings (contact_id);
CREATE INDEX idx_bookings_date ON bookings (booking_date, start_time);
CREATE INDEX idx_bookings_email ON bookings (customer_email);
CREATE INDEX idx_bookings_status ON bookings (status);

-- ============================================================
-- TRIGGERS
-- ============================================================
CREATE TRIGGER event_types_updated_at BEFORE UPDATE ON event_types
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER bookings_updated_at BEFORE UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- BOOKING WEBHOOK FUNCTION
-- Fires the event type's webhook_url when a new booking is created
-- Also creates/links a contact and deal in the CRM automatically
-- ============================================================
CREATE OR REPLACE FUNCTION handle_new_booking()
RETURNS TRIGGER AS $$
DECLARE
  existing_contact_id UUID;
  new_contact_id UUID;
  new_deal_id UUID;
  stage_id UUID;
  event_name TEXT;
  event_webhook TEXT;
  payload JSONB;
BEGIN
  -- Look up the event type
  SELECT name, webhook_url INTO event_name, event_webhook
  FROM event_types WHERE id = NEW.event_type_id;

  -- Find or create contact
  SELECT id INTO existing_contact_id
  FROM contacts WHERE email = NEW.customer_email LIMIT 1;

  IF existing_contact_id IS NOT NULL THEN
    new_contact_id := existing_contact_id;
    -- Update contact if phone was provided
    IF NEW.customer_phone IS NOT NULL THEN
      UPDATE contacts SET phone = COALESCE(phone, NEW.customer_phone)
      WHERE id = new_contact_id;
    END IF;
  ELSE
    INSERT INTO contacts (name, email, phone, lead_source, lead_status)
    VALUES (NEW.customer_name, NEW.customer_email, NEW.customer_phone, 'booking', 'active_trial')
    RETURNING id INTO new_contact_id;
  END IF;

  -- Link booking to contact
  NEW.contact_id := new_contact_id;

  -- Create a deal at "New Lead" stage
  SELECT id INTO stage_id FROM pipeline_stages WHERE slug = 'new_lead' LIMIT 1;

  INSERT INTO deals (title, contact_id, stage_id, status)
  VALUES (
    COALESCE(event_name, 'Consultation') || ' — ' || NEW.customer_name,
    new_contact_id,
    stage_id,
    'open'
  ) RETURNING id INTO new_deal_id;

  -- Fire webhook if configured
  IF event_webhook IS NOT NULL THEN
    payload = jsonb_build_object(
      'event', 'booking.created',
      'booking', jsonb_build_object(
        'id', NEW.id,
        'event_type', event_name,
        'date', NEW.booking_date,
        'start_time', NEW.start_time,
        'end_time', NEW.end_time,
        'status', NEW.status
      ),
      'contact', jsonb_build_object(
        'id', new_contact_id,
        'name', NEW.customer_name,
        'email', NEW.customer_email,
        'phone', NEW.customer_phone
      ),
      'deal', jsonb_build_object(
        'id', new_deal_id
      ),
      'custom_responses', NEW.custom_responses
    );

    PERFORM net.http_post(
      url := event_webhook,
      body := payload::TEXT,
      headers := '{"Content-Type": "application/json"}'::JSONB
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER booking_created_trigger BEFORE INSERT ON bookings
  FOR EACH ROW EXECUTE FUNCTION handle_new_booking();

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE event_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE blocked_times ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated full access" ON event_types
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated full access" ON blocked_times
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated full access" ON bookings
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Public read access for event_types (so booking page can load them)
CREATE POLICY "Public can view active events" ON event_types
  FOR SELECT TO anon USING (active = true);

-- Public can create bookings
CREATE POLICY "Public can create bookings" ON bookings
  FOR INSERT TO anon WITH CHECK (true);

-- Public can read bookings (needed to check slot availability)
CREATE POLICY "Public can view bookings for availability" ON bookings
  FOR SELECT TO anon USING (true);

-- Public can read blocked times (needed for availability check)
CREATE POLICY "Public can view blocked times" ON blocked_times
  FOR SELECT TO anon USING (true);
