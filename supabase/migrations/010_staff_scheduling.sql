-- ============================================================
-- 010: Staff Scheduling — Roster & Shift Management
-- Named shift templates, weekly roster, cross-location shifts,
-- swap requests, and notification tracking
-- ============================================================

-- ============================================================
-- SHIFT TEMPLATES (reusable named shifts per location)
-- e.g. "Morning" 06:00–14:00, "Afternoon" 14:00–22:00
-- ============================================================
CREATE TABLE shift_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,

  name TEXT NOT NULL,                    -- "Morning", "Afternoon", "Evening", "Split"
  start_time TIME NOT NULL,              -- 06:00
  end_time TIME NOT NULL,                -- 14:00
  color TEXT DEFAULT '#3B82F6',          -- Badge colour on the calendar
  role_label TEXT,                       -- Default role label (e.g. "Floor Coach", "Front Desk")

  active BOOLEAN DEFAULT TRUE,
  display_order INT DEFAULT 0,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(location_id, name)
);

CREATE INDEX idx_shift_templates_location ON shift_templates (location_id);

-- Seed some common templates (will be created per-location by UI)
-- (no seed data — users create their own via settings)

-- ============================================================
-- SHIFTS (individual shift assignments — one row per person per day)
-- ============================================================
CREATE TABLE shifts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  shift_template_id UUID NOT NULL REFERENCES shift_templates(id) ON DELETE RESTRICT,

  -- The date this shift is for
  shift_date DATE NOT NULL,

  -- Override start/end from template if needed (null = use template times)
  start_time_override TIME,
  end_time_override TIME,

  -- Shift details
  role_label TEXT,                       -- "Floor Coach", "Front Desk", "PT" — overrides template default
  notes TEXT,                            -- Shift-specific notes

  -- Status
  status TEXT DEFAULT 'scheduled',       -- scheduled, confirmed, completed, cancelled, swapped

  -- Publishing
  published BOOLEAN DEFAULT FALSE,       -- Only visible to staff once published
  published_at TIMESTAMPTZ,

  -- Who created this shift
  created_by UUID REFERENCES profiles(id),

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- Prevent double-booking: one person can't have the same template on the same day at the same location
  UNIQUE(location_id, profile_id, shift_template_id, shift_date)
);

CREATE INDEX idx_shifts_location_date ON shifts (location_id, shift_date);
CREATE INDEX idx_shifts_profile ON shifts (profile_id, shift_date);
CREATE INDEX idx_shifts_date ON shifts (shift_date);
CREATE INDEX idx_shifts_template ON shifts (shift_template_id);
CREATE INDEX idx_shifts_published ON shifts (published, shift_date);

-- ============================================================
-- SHIFT SWAP REQUESTS
-- Staff can request to swap a shift with another staff member
-- ============================================================
CREATE TABLE shift_swap_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,

  -- The shift the requester wants to give away
  requester_shift_id UUID NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  requester_id UUID NOT NULL REFERENCES profiles(id),

  -- The shift they want in return (null = just wants to drop)
  target_shift_id UUID REFERENCES shifts(id) ON DELETE SET NULL,
  target_id UUID REFERENCES profiles(id),

  -- Request details
  reason TEXT,
  status TEXT DEFAULT 'pending',        -- pending, approved, rejected, cancelled

  -- Approval
  reviewed_by UUID REFERENCES profiles(id),
  reviewed_at TIMESTAMPTZ,
  review_note TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_swap_requests_location ON shift_swap_requests (location_id);
CREATE INDEX idx_swap_requests_requester ON shift_swap_requests (requester_id);
CREATE INDEX idx_swap_requests_target ON shift_swap_requests (target_id);
CREATE INDEX idx_swap_requests_status ON shift_swap_requests (status);

-- ============================================================
-- SCHEDULE NOTIFICATIONS LOG
-- Track which notifications have been sent to avoid duplicates
-- ============================================================
CREATE TABLE schedule_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  shift_id UUID REFERENCES shifts(id) ON DELETE SET NULL,

  -- Notification type
  type TEXT NOT NULL,                    -- roster_published, shift_changed, shift_cancelled, swap_requested, swap_approved, swap_rejected
  channel TEXT NOT NULL,                 -- email, whatsapp

  -- Delivery
  sent_at TIMESTAMPTZ DEFAULT NOW(),
  delivered BOOLEAN DEFAULT FALSE,

  -- Reference data
  metadata JSONB DEFAULT '{}'::JSONB,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_schedule_notif_profile ON schedule_notifications (profile_id);
CREATE INDEX idx_schedule_notif_shift ON schedule_notifications (shift_id);

-- ============================================================
-- TRIGGERS
-- ============================================================
CREATE TRIGGER set_shift_templates_updated_at BEFORE UPDATE ON shift_templates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER set_shifts_updated_at BEFORE UPDATE ON shifts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER set_swap_requests_updated_at BEFORE UPDATE ON shift_swap_requests
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE shift_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_swap_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_notifications ENABLE ROW LEVEL SECURITY;

-- Shift templates: all authenticated users can read, managers+ can write
CREATE POLICY "Authenticated can view shift templates" ON shift_templates
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "Managers can manage shift templates" ON shift_templates
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role IN ('owner', 'manager', 'head_coach')
    )
  );

-- Shifts: staff see their own + published shifts at their locations; managers+ see all
CREATE POLICY "Staff can view own shifts" ON shifts
  FOR SELECT TO authenticated
  USING (
    profile_id = auth.uid()
    OR (published = true AND EXISTS (
      SELECT 1 FROM profile_locations pl WHERE pl.profile_id = auth.uid() AND pl.location_id = shifts.location_id
    ))
  );

CREATE POLICY "Managers can view all shifts" ON shifts
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role IN ('owner', 'manager', 'head_coach')
    )
  );

CREATE POLICY "Managers can manage shifts" ON shifts
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role IN ('owner', 'manager', 'head_coach')
    )
  );

-- Swap requests: staff can see their own, managers see all
CREATE POLICY "Staff can view own swap requests" ON shift_swap_requests
  FOR SELECT TO authenticated
  USING (requester_id = auth.uid() OR target_id = auth.uid());

CREATE POLICY "Managers can view all swap requests" ON shift_swap_requests
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role IN ('owner', 'manager', 'head_coach')
    )
  );

CREATE POLICY "Staff can create swap requests" ON shift_swap_requests
  FOR INSERT TO authenticated
  WITH CHECK (requester_id = auth.uid());

CREATE POLICY "Managers can manage swap requests" ON shift_swap_requests
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role IN ('owner', 'manager', 'head_coach')
    )
  );

-- Notifications: users see their own
CREATE POLICY "Users can view own notifications" ON schedule_notifications
  FOR SELECT TO authenticated
  USING (profile_id = auth.uid());

-- Service role full access (for API routes)
CREATE POLICY "Service role full access" ON shift_templates FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON shifts FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON shift_swap_requests FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON schedule_notifications FOR ALL USING (true) WITH CHECK (true);

-- ============================================================
-- Add schedule permission to profiles default
-- ============================================================
COMMENT ON TABLE shift_templates IS 'Reusable named shift definitions per location (e.g. Morning 06:00-14:00)';
COMMENT ON TABLE shifts IS 'Individual shift assignments — one row per person per day per template';
COMMENT ON TABLE shift_swap_requests IS 'Staff-initiated shift swap requests requiring manager approval';
