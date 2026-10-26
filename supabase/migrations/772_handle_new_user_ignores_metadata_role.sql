-- PINSCOPE.1 — handle_new_user() stops trusting the caller's metadata.
--
-- Mig 551 minted a profile for invited_for='staff' and took its ROLE and
-- PERMISSIONS from raw_user_meta_data, then attached it to
-- `locations WHERE active LIMIT 1` (an arbitrary studio, no ORDER BY).
-- raw_user_meta_data is written by the caller on a public GoTrue sign-up
-- (`signUp({ options: { data: { invited_for: 'staff', role: 'master' } } })`),
-- so the moment "Allow new users to sign up" was on, anyone could mint a
-- master. /api/staff, the only legitimate writer of the marker, never sent
-- a role or permissions: it updates profiles.role afterwards and deletes the
-- trigger's profile_locations row before inserting its own assignments.
--
-- Now the trigger mints an INACTIVE 'staff' profile with the default
-- permissions and NO location. getCurrentUser refuses an inactive profile
-- (src/lib/auth.js), so a forged sign-up yields an inert row. /api/staff
-- sets active = true in the same checked update that sets the role (that
-- route change ships first; it is harmless against mig 551).
--
-- CREATE OR REPLACE keeps the function's ACL (trigger function; no EXECUTE
-- grant needed).

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  invited_for_val text := coalesce(new.raw_user_meta_data->>'invited_for', '');
begin
  -- POSITIVE ALLOWLIST: only explicit staff invites (/api/staff stamps
  -- invited_for='staff') mint a staff profile. Everything else — customer
  -- invites, host invites, review-login, dashboard-created users, empty
  -- metadata — mints nothing. Staff onboarding is /api/staff ONLY.
  if invited_for_val <> 'staff' then
    raise log 'handle_new_user: no profile minted (invited_for=%) user=%', invited_for_val, new.id;
    return new;
  end if;

  -- Defence-in-depth: forged invited_for='staff' carrying customer/host markers fails safe.
  if (new.raw_user_meta_data ? 'contact_id')
     or (new.raw_user_meta_data ? 'host_id') then
    raise log 'handle_new_user: no profile minted (marker conflict) user=%', new.id;
    return new;
  end if;

  -- Role, permissions and access are NEVER read from the metadata: the
  -- invite route grants them server-side after this insert.
  insert into profiles (id, email, full_name, role, permissions, active)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.email),
    'staff',
    '{"dashboard":true,"pipeline":true,"contacts":true,"events":true,"bookings":true,"activities":true,"settings":false}'::jsonb,
    false
  );

  return new;
end;
$function$;
