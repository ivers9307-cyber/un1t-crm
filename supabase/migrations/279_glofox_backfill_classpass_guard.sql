-- 279_glofox_backfill_classpass_guard.sql — fix the ClassPass exclusion
-- in the backfill eligibility RPCs. ClassPass is tracked via
-- contacts.lead_source='classpass' (NOT contacts.source, which never
-- holds 'classpass'), matching the rest of the codebase (person-match,
-- lead-radar, pipeline-classifier). The mig-278 `source <> 'classpass'`
-- clause was a no-op (safe today only because every ClassPass contact is
-- already Glofox-linked); this makes the guard real. Both signals kept
-- belt-and-braces.

create or replace function public.glofox_backfill_eligible_count(p_location_id uuid)
returns bigint language sql stable security invoker set search_path = public as $$
  select count(*)::bigint
  from contacts c
  where c.location_id = p_location_id
    and c.glofox_member_id is null
    and c.email is not null
    and coalesce(c.lead_source, '') <> 'classpass'
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
    and coalesce(c.lead_source, '') <> 'classpass'
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
