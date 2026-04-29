-- ============================================================
-- 004: Authentication, Multi-Tenant, and Permissions
-- ============================================================

-- ============================================================
-- LOCATIONS
-- ============================================================
CREATE TABLE locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  address TEXT,
  phone TEXT,
  email TEXT,
  timezone TEXT DEFAULT 'Europe/Dublin',
  active BOOLEAN DEFAULT TRUE,
  settings JSONB DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed UN1T Stillorgan as the first location
INSERT INTO locations (id, name, slug, address, active)
VALUES (
  'a0000000-0000-0000-0000-000000000001',
  'UN1T Stillorgan',
  'un1t-stillorgan',
  'Stillorgan, Dublin, Ireland',
  true
);

-- ============================================================
-- PROFILES (extends Supabase auth.users)
-- ============================================================
CREATE TABLE profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff',  -- owner, manager, staff
  avatar_url TEXT,
  active BOOLEAN DEFAULT TRUE,

  -- Feature permissions — all toggleable
  permissions JSONB DEFAULT '{
    "dashboard": true,
    "pipeline": true,
    "contacts": true,
    "events": true,
    "bookings": true,
    "activities": true,
    "settings": false
  }'::JSONB,

  -- 2FA
  two_factor_enabled BOOLEAN DEFAULT FALSE,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_profiles_email ON profiles (email);
CREATE INDEX idx_profiles_role ON profiles (role);

-- ============================================================
-- PROFILE <-> LOCATION (many-to-many)
-- ============================================================
CREATE TABLE profile_locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  is_default BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (profile_id, location_id)
);

CREATE INDEX idx_profile_locations_profile ON profile_locations (profile_id);
CREATE INDEX idx_profile_locations_location ON profile_locations (location_id);

-- ============================================================
-- ADD location_id TO ALL DATA TABLES
-- ============================================================

-- Contacts
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id);
UPDATE contacts SET location_id = 'a0000000-0000-0000-0000-000000000001' WHERE location_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_location ON contacts (location_id);

-- Deals
ALTER TABLE deals ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id);
UPDATE deals SET location_id = 'a0000000-0000-0000-0000-000000000001' WHERE location_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_deals_location ON deals (location_id);

-- Notes
ALTER TABLE notes ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id);
UPDATE notes SET location_id = 'a0000000-0000-0000-0000-000000000001' WHERE location_id IS NULL;

-- Activities
ALTER TABLE activities ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id);
UPDATE activities SET location_id = 'a0000000-0000-0000-0000-000000000001' WHERE location_id IS NULL;

-- Event Types
ALTER TABLE event_types ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id);
UPDATE event_types SET location_id = 'a0000000-0000-0000-0000-000000000001' WHERE location_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_event_types_location ON event_types (location_id);

-- Bookings
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id);
UPDATE bookings SET location_id = 'a0000000-0000-0000-0000-000000000001' WHERE location_id IS NULL;

-- Pipeline Stages (shared across locations for now, but adding for future)
ALTER TABLE pipeline_stages ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id);
UPDATE pipeline_stages SET location_id = 'a0000000-0000-0000-0000-000000000001' WHERE location_id IS NULL;

-- Webhook Subscriptions
ALTER TABLE webhook_subscriptions ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id);
UPDATE webhook_subscriptions SET location_id = 'a0000000-0000-0000-0000-000000000001' WHERE location_id IS NULL;

-- ============================================================
-- AUTO-CREATE PROFILE ON SIGNUP
-- When a user signs up via Supabase Auth, auto-create their profile
-- ============================================================
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO profiles (id, email, full_name, role, permissions)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email),
    COALESCE(NEW.raw_user_meta_data->>'role', 'staff'),
    COALESCE(
      (NEW.raw_user_meta_data->>'permissions')::JSONB,
      '{"dashboard":true,"pipeline":true,"contacts":true,"events":true,"bookings":true,"activities":true,"settings":false}'::JSONB
    )
  );

  -- Auto-assign to default location if one exists
  INSERT INTO profile_locations (profile_id, location_id, is_default)
  SELECT NEW.id, id, true
  FROM locations
  WHERE active = true
  LIMIT 1;

  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION handle_new_user();

-- ============================================================
-- UPDATE handle_new_booking TO SET location_id
-- ============================================================
CREATE OR REPLACE FUNCTION handle_new_booking()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql
AS $$
DECLARE
  v_contact_id UUID;
  v_event_name TEXT;
  v_webhook_url TEXT;
  v_stage_id UUID;
  v_deal_id UUID;
  v_location_id UUID;
BEGIN
  -- Get location from the event type
  SELECT name, location_id, webhook_url
  INTO v_event_name, v_location_id, v_webhook_url
  FROM event_types
  WHERE id = NEW.event_type_id;

  -- Set location on booking
  NEW.location_id := v_location_id;

  -- Find or create contact
  SELECT id INTO v_contact_id
  FROM contacts
  WHERE email = NEW.customer_email
  LIMIT 1;

  IF v_contact_id IS NULL THEN
    INSERT INTO contacts (name, email, phone, source, location_id)
    VALUES (NEW.customer_name, NEW.customer_email, NEW.customer_phone, 'booking', v_location_id)
    RETURNING id INTO v_contact_id;
  END IF;

  -- Link booking to contact
  NEW.contact_id := v_contact_id;

  -- Look up the "New Lead" pipeline stage for this location
  SELECT id INTO v_stage_id
  FROM pipeline_stages
  WHERE slug = 'new_lead' AND (location_id = v_location_id OR location_id IS NULL)
  LIMIT 1;

  -- Create deal
  INSERT INTO deals (contact_id, title, stage_id, status, location_id)
  VALUES (
    v_contact_id,
    COALESCE(v_event_name, 'Booking') || ' — ' || NEW.customer_name,
    v_stage_id,
    'open',
    v_location_id
  )
  RETURNING id INTO v_deal_id;

  -- Log booking confirmation to timeline
  INSERT INTO activities (
    subject, type, contact_id, deal_id, due_date, due_time, note, done, location_id
  ) VALUES (
    'Booking confirmed: ' || COALESCE(v_event_name, 'Event'),
    'booking',
    v_contact_id,
    v_deal_id,
    NEW.booking_date,
    NEW.start_time,
    'Booked ' || COALESCE(v_event_name, 'Event') || ' on ' ||
      TO_CHAR(NEW.booking_date, 'DD Mon YYYY') || ' at ' ||
      TO_CHAR(NEW.start_time, 'HH12:MI AM') ||
      '. Source: ' || COALESCE(NEW.source, 'booking_page'),
    false,
    v_location_id
  );

  -- Fire webhook if configured
  IF v_webhook_url IS NOT NULL AND v_webhook_url != '' THEN
    BEGIN
      PERFORM net.http_post(
        url := v_webhook_url,
        body := json_build_object(
          'event', 'booking.created',
          'booking_id', NEW.id,
          'contact_id', v_contact_id,
          'customer_name', NEW.customer_name,
          'customer_email', NEW.customer_email,
          'event_type', v_event_name,
          'booking_date', NEW.booking_date,
          'start_time', NEW.start_time,
          'location_id', v_location_id
        )::jsonb
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE LOG 'Webhook failed for booking %: %', NEW.id, SQLERRM;
    END;
  END IF;

  RETURN NEW;
END;
$$;

-- ============================================================
-- UPDATE log_deal_stage_change TO INCLUDE location_id
-- ============================================================
CREATE OR REPLACE FUNCTION log_deal_stage_change()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql
AS $$
DECLARE
  v_old_stage TEXT;
  v_new_stage TEXT;
BEGIN
  IF OLD.stage_id IS DISTINCT FROM NEW.stage_id THEN
    SELECT name INTO v_old_stage FROM pipeline_stages WHERE id = OLD.stage_id;
    SELECT name INTO v_new_stage FROM pipeline_stages WHERE id = NEW.stage_id;

    INSERT INTO activities (subject, type, contact_id, deal_id, note, done, location_id)
    VALUES (
      'Pipeline: moved to ' || COALESCE(v_new_stage, 'Unknown'),
      'pipeline',
      NEW.contact_id,
      NEW.id,
      'Deal "' || NEW.title || '" moved from ' ||
        COALESCE(v_old_stage, 'Unknown') || ' to ' || COALESCE(v_new_stage, 'Unknown'),
      true,
      NEW.location_id
    );
  END IF;
  RETURN NEW;
END;
$$;

-- ============================================================
-- UPDATE log_booking_status_change TO INCLUDE location_id
-- ============================================================
CREATE OR REPLACE FUNCTION log_booking_status_change()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql
AS $$
DECLARE
  v_event_name TEXT;
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    SELECT name INTO v_event_name FROM event_types WHERE id = NEW.event_type_id;

    INSERT INTO activities (subject, type, contact_id, due_date, due_time, note, done, location_id)
    VALUES (
      'Booking ' || NEW.status || ': ' || COALESCE(v_event_name, 'Event'),
      'booking',
      NEW.contact_id,
      NEW.booking_date,
      NEW.start_time,
      COALESCE(v_event_name, 'Event') || ' on ' ||
        TO_CHAR(NEW.booking_date, 'DD Mon YYYY') || ' — status changed from ' ||
        OLD.status || ' to ' || NEW.status,
      true,
      NEW.location_id
    );
  END IF;
  RETURN NEW;
END;
$$;

-- ============================================================
-- RLS POLICIES FOR NEW TABLES
-- ============================================================
ALTER TABLE locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE profile_locations ENABLE ROW LEVEL SECURITY;

-- Profiles: users can read all profiles in their locations, edit own
CREATE POLICY "Users can view own profile" ON profiles
  FOR SELECT TO authenticated
  USING (id = auth.uid());

CREATE POLICY "Admins can view all profiles" ON profiles
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role IN ('owner', 'manager')
    )
  );

CREATE POLICY "Admins can manage profiles" ON profiles
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'owner'
    )
  );

CREATE POLICY "Users can update own profile" ON profiles
  FOR UPDATE TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

-- Locations: authenticated users can read their assigned locations
CREATE POLICY "Users can view assigned locations" ON locations
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profile_locations pl WHERE pl.location_id = id AND pl.profile_id = auth.uid()
    )
  );

CREATE POLICY "Owners can manage locations" ON locations
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'owner'
    )
  );

-- Profile locations: users can see their own assignments
CREATE POLICY "Users can view own location assignments" ON profile_locations
  FOR SELECT TO authenticated
  USING (profile_id = auth.uid());

CREATE POLICY "Owners can manage location assignments" ON profile_locations
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'owner'
    )
  );

-- Service role bypasses RLS automatically (used by API routes)
