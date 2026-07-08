-- HOST-PORTAL.1 (fix) — gate handle_new_user for host-portal invites.
--
-- handle_new_user (mig 098) inserted a profiles(role='staff') + a
-- profile_locations row UNCONDITIONALLY for every new auth.users row. That
-- silently made every host-portal auth user ALSO a staff account with access
-- to a live location's dashboard/pipeline/contacts — a host→staff-CRM
-- privilege escalation — and broke the getCurrentHost/getCurrentUser firewall
-- (which assumes host auth users have NO profiles row).
--
-- Host invites carry raw_user_meta_data->>'invited_for' = 'host-portal' (set by
-- POST /api/hosts/[id]/invite via inviteUserByEmail's `data`). Short-circuit
-- for them: NO profiles row, NO profile_locations row — they resolve ONLY to an
-- event_host via host_users. Body is otherwise identical to mig 098.

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
  -- Host-portal invitees are not staff — no profiles / profile_locations row.
  if coalesce(new.raw_user_meta_data->>'invited_for', '') = 'host-portal' then
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
