-- ============================================================
-- 011: Time Off — Holiday, Sick Leave & Unavailability
-- Staff request time off, managers/owners/head_coaches approve.
-- Approved time-off shows as coloured bars on the schedule.
-- Annual holiday allowance tracking per staff member.
-- ============================================================

-- ============================================================
-- STAFF ALLOWANCES (annual holiday balance per staff member)
-- ============================================================
CREATE TABLE staff_allowances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  year INT NOT NULL,                         -- e.g. 2026
  total_days NUMERIC(5,1) NOT NULL DEFAULT 20, -- total annual entitlement
  used_days NUMERIC(5,1) NOT NULL DEFAULT 0,   -- days used so far
  carried_over NUMERIC(5,1) NOT NULL DEFAULT 0, -- days carried from prev year

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(profile_id, year)
);

CREATE INDEX idx_staff_allowances_profile ON staff_allowances (profile_id);

-- ============================================================
-- TIME OFF REQUESTS
-- ============================================================
CREATE TABLE time_off_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,

  type TEXT NOT NULL CHECK (type IN ('holiday', 'sick', 'unavailable')),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,                    -- inclusive
  total_days NUMERIC(5,1) NOT NULL DEFAULT 1, -- calculated days (supports half days)
  reason TEXT,

  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  reviewed_by UUID REFERENCES profiles(id),
  reviewed_at TIMESTAMPTZ,
  review_note TEXT,                          -- optional note from approver

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT valid_date_range CHECK (end_date >= start_date)
);

CREATE INDEX idx_time_off_profile ON time_off_requests (profile_id);
CREATE INDEX idx_time_off_location ON time_off_requests (location_id);
CREATE INDEX idx_time_off_dates ON time_off_requests (start_date, end_date);
CREATE INDEX idx_time_off_status ON time_off_requests (status);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE staff_allowances ENABLE ROW LEVEL SECURITY;
ALTER TABLE time_off_requests ENABLE ROW LEVEL SECURITY;

-- Staff can view their own allowances
CREATE POLICY "Staff can view own allowances"
  ON staff_allowances FOR SELECT
  USING (profile_id = auth.uid());

-- Managers/owners/head_coaches can view all allowances
CREATE POLICY "Admins can view all allowances"
  ON staff_allowances FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('owner', 'manager', 'head_coach')
    )
  );

-- Managers/owners can manage allowances
CREATE POLICY "Admins can manage allowances"
  ON staff_allowances FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('owner', 'manager')
    )
  );

-- Staff can view their own time-off requests
CREATE POLICY "Staff can view own time off"
  ON time_off_requests FOR SELECT
  USING (profile_id = auth.uid());

-- Managers/owners/head_coaches can view all time-off requests
CREATE POLICY "Admins can view all time off"
  ON time_off_requests FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('owner', 'manager', 'head_coach')
    )
  );

-- Staff can create their own time-off requests
CREATE POLICY "Staff can create own time off"
  ON time_off_requests FOR INSERT
  WITH CHECK (profile_id = auth.uid());

-- Staff can cancel their own pending requests
CREATE POLICY "Staff can cancel own pending time off"
  ON time_off_requests FOR UPDATE
  USING (profile_id = auth.uid() AND status = 'pending')
  WITH CHECK (status = 'cancelled');

-- Managers/owners/head_coaches can update any request (approve/reject)
CREATE POLICY "Admins can manage time off"
  ON time_off_requests FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('owner', 'manager', 'head_coach')
    )
  );

-- ============================================================
-- FUNCTION: Auto-update used_days when a holiday request is approved
-- ============================================================
CREATE OR REPLACE FUNCTION update_holiday_allowance()
RETURNS TRIGGER AS $$
BEGIN
  -- When a holiday request is approved, increment used_days
  IF NEW.type = 'holiday' AND NEW.status = 'approved' AND (OLD.status IS NULL OR OLD.status != 'approved') THEN
    INSERT INTO staff_allowances (profile_id, year, total_days, used_days)
    VALUES (NEW.profile_id, EXTRACT(YEAR FROM NEW.start_date)::INT, 20, NEW.total_days)
    ON CONFLICT (profile_id, year)
    DO UPDATE SET
      used_days = staff_allowances.used_days + NEW.total_days,
      updated_at = NOW();
  END IF;

  -- When a previously approved holiday is cancelled or rejected, decrement used_days
  IF NEW.type = 'holiday' AND OLD.status = 'approved' AND NEW.status IN ('cancelled', 'rejected') THEN
    UPDATE staff_allowances
    SET used_days = GREATEST(0, used_days - OLD.total_days),
        updated_at = NOW()
    WHERE profile_id = OLD.profile_id
    AND year = EXTRACT(YEAR FROM OLD.start_date)::INT;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_update_holiday_allowance
  AFTER UPDATE ON time_off_requests
  FOR EACH ROW
  EXECUTE FUNCTION update_holiday_allowance();
