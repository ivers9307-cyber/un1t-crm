-- MOBILE-RLS.1 (helpers) — mirror the app's mobile permission resolver
-- (shared/permissions.js → resolvePermission) in SQL so RLS can gate
-- direct-client (mobile) CRUD by role + per-user toggle, not just
-- location. Additive — creates a defaults table + two functions, changes
-- no policy. Applied to prod via Supabase MCP on 2026-05-29.
CREATE TABLE IF NOT EXISTS private.mobile_permission_defaults (
  role text NOT NULL, key text NOT NULL, allowed boolean NOT NULL,
  PRIMARY KEY (role, key)
);
INSERT INTO private.mobile_permission_defaults (role, key, allowed) VALUES
  ('staff','pipeline',false),('staff','tasks',true),('staff','bookings',false),('staff','whatsapp',false),
  ('head_coach','pipeline',true),('head_coach','tasks',true),('head_coach','bookings',true),('head_coach','whatsapp',true),
  ('manager','pipeline',true),('manager','tasks',true),('manager','bookings',true),('manager','whatsapp',true),
  ('owner','pipeline',true),('owner','tasks',true),('owner','bookings',true),('owner','whatsapp',true)
ON CONFLICT (role, key) DO UPDATE SET allowed = EXCLUDED.allowed;

CREATE OR REPLACE FUNCTION private.mobile_can_for(p_uid uuid, loc_id uuid, perm_key text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT loc_id IS NOT NULL
    AND coalesce((SELECT (features -> perm_key) <> 'false'::jsonb FROM public.locations WHERE id = loc_id), true)
    AND (
      (SELECT role = 'master' FROM public.profiles WHERE id = p_uid)
      OR EXISTS (
        SELECT 1 FROM public.profile_locations pl
        WHERE pl.profile_id = p_uid AND pl.location_id = loc_id
          AND CASE
            WHEN pl.permissions -> 'mobile' ? perm_key
              THEN (pl.permissions -> 'mobile' ->> perm_key) = 'true'
            ELSE coalesce((SELECT d.allowed FROM private.mobile_permission_defaults d
                           WHERE d.role = pl.role AND d.key = perm_key), false)
          END
      )
    )
$$;

CREATE OR REPLACE FUNCTION private.auth_mobile_can(loc_id uuid, perm_key text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT private.mobile_can_for((SELECT auth.uid()), loc_id, perm_key)
$$;
