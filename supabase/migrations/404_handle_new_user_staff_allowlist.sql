-- 404_handle_new_user_staff_allowlist.sql
-- Invert handle_new_user() from a denylist to an allowlist so it creates a
-- staff profile ONLY for genuine staff invites. Previously it skipped only
-- invited_for='host-portal' (mig 387), so a customer invite (invited_for set +
-- contact_id metadata) also received a staff profile + profile_locations. Now
-- any non-null, non-'staff' invited_for, or the presence of a contact_id/host_id
-- marker, fails safe (no profile). Applied to prod via Supabase MCP; this file
-- mirrors what was applied, plus a scoped one-time purge of the profiles created
-- for customers before the fix (identified and confirmed by SELECT, deleted by
-- data predicate; auth.users and contacts are left intact).
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  invited_for_val      text := coalesce(new.raw_user_meta_data->>'invited_for', '');
  resolved_role        text;
  resolved_permissions jsonb;
begin
  -- Only genuine staff invites (no invited_for / explicit 'staff', and no
  -- contact_id/host_id marker) get a profiles/profile_locations row.
  if invited_for_val <> '' and invited_for_val <> 'staff' then
    return new;
  end if;
  if (new.raw_user_meta_data ? 'contact_id')
     or (new.raw_user_meta_data ? 'host_id') then
    return new;
  end if;

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

  insert into profile_locations (profile_id, location_id, is_default, role, permissions)
  select new.id, id, true, resolved_role, resolved_permissions
  from locations
  where active = true
  limit 1;

  return new;
end;
$function$;

-- One-time purge of staff profiles created for app customers before the fix.
-- profile_locations cascades (FK ON DELETE CASCADE); auth.users + contacts are
-- deliberately untouched so the customer keeps their app login.
DELETE FROM public.profiles p
USING auth.users u
WHERE p.id = u.id
  AND ( coalesce(u.raw_user_meta_data->>'invited_for','') = 'champ-app'
        OR (u.raw_user_meta_data ? 'contact_id') );

-- Follow-up (tracked separately): the app-review demo logins are created via
-- admin.createUser with no invited_for and no contact_id, so under this
-- allowlist they would still receive a staff profile. The review-login path
-- should create them with a customer marker (or strip their staff profile).
