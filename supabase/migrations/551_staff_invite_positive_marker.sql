-- Phase 0a (Repset one-app merge): TRUE inversion of handle_new_user.
-- Minting a profiles row now requires the explicit positive marker set by
-- /api/staff (invited_for='staff', live since un1t-crm PR #1430 / 812e2da4).
-- Empty/absent metadata mints NOTHING (previously it minted a staff profile).
-- APPLIED TO PROD 2026-08-17 via Supabase MCP (staff_invite_positive_marker);
-- verified live with a rolled-back 4-case trigger test (staff invite mints,
-- empty-metadata / customer-invite / forged-marker mint nothing).

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

-- Provenance-verified purge (audit 2026-08-17, all 16 profiles reviewed):
-- exactly ONE profile lacked trustworthy staff provenance —
-- richard.ivers3+1@gmail.com ("richard test", May-13 escalation-era artifact).
-- Kept deliberately: apple-review@un1tdublin.com (staff demo scoped to Test Studio).
DELETE FROM profile_locations pl
USING profiles p
WHERE pl.profile_id = p.id
  AND p.id = 'f6168b8d-7476-4998-81fb-e98c3c02a1f7'
  AND p.email = 'richard.ivers3+1@gmail.com';

DELETE FROM profiles
WHERE id = 'f6168b8d-7476-4998-81fb-e98c3c02a1f7'
  AND email = 'richard.ivers3+1@gmail.com';
