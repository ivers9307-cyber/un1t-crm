-- ============================================================
-- 009: Add Head Coach role
-- New role between Manager and Staff with customizable per-user permissions
-- ============================================================

-- Update the profiles role column comment
COMMENT ON COLUMN profiles.role IS 'owner, manager, head_coach, staff';

-- Update default permissions to include email and whatsapp keys
-- (existing users keep their current permissions; new users get the expanded set)
ALTER TABLE profiles ALTER COLUMN permissions SET DEFAULT '{
  "dashboard": true,
  "pipeline": true,
  "contacts": true,
  "events": true,
  "bookings": true,
  "activities": true,
  "email": false,
  "whatsapp": false,
  "settings": false
}'::JSONB;

-- Update "Admins can view all profiles" policy to include head_coach
DROP POLICY IF EXISTS "Admins can view all profiles" ON profiles;
CREATE POLICY "Admins can view all profiles" ON profiles
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role IN ('owner', 'manager', 'head_coach')
    )
  );
