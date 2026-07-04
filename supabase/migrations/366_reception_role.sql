-- RECEPTION.1 — new per-location role 'reception' (front-of-house desk).
--
-- Authz tier: same as staff (NOT in ADMIN_ROLES / MANAGER_ROLES, and
-- the manager-tier DB helpers — auth_is_manager_at,
-- auth_is_admin_or_head_coach — correctly exclude it with no change).
-- Code defaults live in shared/permissions.js (staff-level access +
-- the WhatsApp inbox + the bookings desk); operators tune per
-- location via the Roles tab (location_role_permissions, mig 364).
--
-- Three CHECK constraints enumerate per-location roles; widen each.

ALTER TABLE profile_locations
  DROP CONSTRAINT profile_locations_role_check,
  ADD CONSTRAINT profile_locations_role_check
    CHECK (role = ANY (ARRAY['owner'::text, 'manager'::text, 'head_coach'::text, 'staff'::text, 'reception'::text]));

ALTER TABLE location_role_permissions
  DROP CONSTRAINT location_role_permissions_role_check,
  ADD CONSTRAINT location_role_permissions_role_check
    CHECK (role = ANY (ARRAY['owner'::text, 'manager'::text, 'head_coach'::text, 'staff'::text, 'reception'::text]));

ALTER TABLE checklist_templates
  DROP CONSTRAINT checklist_templates_role_check,
  ADD CONSTRAINT checklist_templates_role_check
    CHECK (role = ANY (ARRAY['staff'::text, 'head_coach'::text, 'manager'::text, 'owner'::text, 'reception'::text]));
