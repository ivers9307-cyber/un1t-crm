-- handle_new_user used to insert into profile_locations with just
-- (profile_id, location_id, is_default). Mig 080 added role +
-- permissions as NOT NULL on profile_locations so per-location
-- access could differ from the global profiles row. The trigger
-- was never updated to match — so every fresh signup via
-- inviteUserByEmail blew up with "Database error saving new user".
--
-- Fix: copy the role + permissions from user_metadata onto the
-- profile_locations row too. Falls back to the same defaults the
-- profiles insert uses, so the constraint never NULLs out.
--
-- Applied via Supabase MCP on 2026-05-05.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  resolved_role       text;
  resolved_permissions jsonb;
begin
  resolved_role := coalesce(new.raw_user_meta_data->>'role', 'staff');
  resolved_permissions := coalesce(
    (new.raw_user_meta_data->>'permissions')::jsonb,
    '{"dashboard":true,"pipeline":true,"contacts":true,"events":true,"bookings":true,"activities":true,"settings":false}'::jsonb
  );

  insert into profiles (id, email, full_name, role, permissions)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.email),
    resolved_role,
    resolved_permissions
  );

  -- Default-location auto-assignment. Only fires if at least one
  -- active location exists. Carries the same role + permissions
  -- so the per-location row is valid against the NOT NULL columns.
  insert into profile_locations (profile_id, location_id, is_default, role, permissions)
  select
    new.id,
    id,
    true,
    resolved_role,
    resolved_permissions
  from locations
  where active = true
  limit 1;

  return new;
end;
$function$;
