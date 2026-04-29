-- ============================================================
-- 012: HR Fields & Scheduled Reporting
-- Add employment details to profiles (FTE vs contractor,
-- salary, hourly rate, contracted hours). Scheduled reports
-- table for recurring report generation.
-- ============================================================

-- ============================================================
-- HR FIELDS ON PROFILES
-- ============================================================
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS employment_type TEXT DEFAULT 'fte' CHECK (employment_type IN ('fte', 'contractor'));
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS annual_salary NUMERIC(10,2);           -- FTE: gross annual salary in EUR
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS hourly_rate NUMERIC(8,2);              -- Contractor: hourly rate in EUR
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS contracted_hours_per_week NUMERIC(5,1) DEFAULT 40; -- FTE: weekly hours
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS annual_leave_entitlement NUMERIC(5,1) DEFAULT 20;  -- FTE: annual leave days

-- ============================================================
-- SCHEDULED REPORTS
-- ============================================================
CREATE TABLE scheduled_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES profiles(id),

  report_type TEXT NOT NULL CHECK (report_type IN (
    'staff_hours', 'staff_cost', 'time_off_summary',
    'roster_coverage', 'utilisation'
  )),
  report_name TEXT NOT NULL,                 -- user-given name, e.g. "Weekly Staff Costs"

  -- Schedule
  frequency TEXT NOT NULL CHECK (frequency IN ('once', 'weekly', 'fortnightly', 'monthly')),
  day_of_week INT,                           -- 0=Mon..6=Sun (for weekly/fortnightly)
  day_of_month INT,                          -- 1-28 (for monthly)
  next_run_at TIMESTAMPTZ,
  last_run_at TIMESTAMPTZ,

  -- Delivery
  deliver_email BOOLEAN DEFAULT FALSE,
  email_recipients TEXT[],                   -- array of email addresses
  deliver_notification BOOLEAN DEFAULT TRUE,
  active BOOLEAN DEFAULT TRUE,

  -- Report parameters (stored as JSON)
  parameters JSONB DEFAULT '{}',             -- e.g. { "period_days": 7 }

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_scheduled_reports_location ON scheduled_reports (location_id);
CREATE INDEX idx_scheduled_reports_next_run ON scheduled_reports (next_run_at) WHERE active = TRUE;

-- ============================================================
-- GENERATED REPORTS (output of each run)
-- ============================================================
CREATE TABLE generated_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scheduled_report_id UUID REFERENCES scheduled_reports(id) ON DELETE SET NULL,
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  generated_by UUID REFERENCES profiles(id),

  report_type TEXT NOT NULL,
  report_name TEXT NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,

  -- Report data stored as JSON for flexible rendering
  report_data JSONB NOT NULL DEFAULT '{}',
  summary JSONB,                             -- quick stats for cards

  -- Delivery status
  email_sent BOOLEAN DEFAULT FALSE,
  notification_sent BOOLEAN DEFAULT FALSE,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_generated_reports_location ON generated_reports (location_id);
CREATE INDEX idx_generated_reports_type ON generated_reports (report_type);
CREATE INDEX idx_generated_reports_created ON generated_reports (created_at DESC);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE scheduled_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE generated_reports ENABLE ROW LEVEL SECURITY;

-- Managers/owners/head_coaches can manage scheduled reports
CREATE POLICY "Admins can manage scheduled reports"
  ON scheduled_reports FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('owner', 'manager', 'head_coach')
    )
  );

-- Managers/owners/head_coaches can view generated reports
CREATE POLICY "Admins can view generated reports"
  ON generated_reports FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('owner', 'manager', 'head_coach')
    )
  );
