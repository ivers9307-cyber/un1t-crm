-- 278_glofox_backfill_rpcs.sql — eligibility for the Glofox lead-
-- provisioning backfill (Automations Phase 2). Eligible = a contact at
-- the location with no glofox_member_id, a real email, not a ClassPass
-- shadow, and NOT already create-attempted by the automation (no
-- glofox_push_events row with source='automation'). The last clause is
-- what lets "remaining" reach 0 — permanently-failing contacts get one
-- attempt (which writes an 'automation' event) then drop out.
--
-- SECURITY INVOKER (runs as the caller). Only the service-role backfill
-- route calls these; execute is revoked from anon/authenticated so the
-- RPC isn't exposed via PostgREST to signed-in users.

create or replace function public.glofox_backfill_eligible_count(p_location_id uuid)
returns bigint language sql stable security invoker set search_path = public as $$
  select count(*)::bigint
  from contacts c
  where c.location_id = p_location_id
    and c.glofox_member_id is null
    and c.email is not null
    and coalesce(c.source, '') <> 'classpass'
    and not exists (
      select 1 from glofox_push_events e
      where e.contact_id = c.id and e.source = 'automation'
    );
$$;

create or replace function public.glofox_backfill_eligible_batch(p_location_id uuid, p_limit int)
returns setof contacts language sql stable security invoker set search_path = public as $$
  select c.*
  from contacts c
  where c.location_id = p_location_id
    and c.glofox_member_id is null
    and c.email is not null
    and coalesce(c.source, '') <> 'classpass'
    and not exists (
      select 1 from glofox_push_events e
      where e.contact_id = c.id and e.source = 'automation'
    )
  order by c.created_at asc
  limit greatest(1, least(coalesce(p_limit, 20), 50));
$$;

revoke execute on function public.glofox_backfill_eligible_count(uuid) from public, anon, authenticated;
revoke execute on function public.glofox_backfill_eligible_batch(uuid, int) from public, anon, authenticated;
