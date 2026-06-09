-- 251 — crossover_contact_ids RPC.
--
-- Fixes a 414 "Request-URI Too Large" on the contacts list/search: the
-- crossover feature (PR #393) built `location_id.eq.L OR id.in.(<ids>)`,
-- where <ids> was EVERY deal-holder at the studio. At Stillorgan that's
-- 8,234 uuids ≈ 300KB of URL — far past Cloudflare's limit. But the
-- location's own deal-holders are already matched by `location_id = L`, so
-- the only ids that need to be in the id.in() are GENUINE crossovers: a
-- contact with a deal here but OWNED by a different studio.
--
-- This RPC computes that set server-side (a join, so the huge deal-holder
-- list never leaves Postgres) and returns the small result. Called only by
-- the service-role client from src/lib/contact-crossovers.js.
create or replace function public.crossover_contact_ids(loc uuid)
returns table (contact_id uuid)
language sql
stable
set search_path = ''
as $$
  select distinct d.contact_id
  from public.deals d
  join public.contacts c on c.id = d.contact_id
  where d.location_id = loc
    and c.location_id is distinct from loc   -- owned by ANOTHER studio (or none)
    and d.contact_id is not null
$$;

-- Server-side only: the contacts page + search route call this via the
-- service-role client. Don't expose it as a public PostgREST RPC.
revoke all on function public.crossover_contact_ids(uuid) from public, anon, authenticated;
grant execute on function public.crossover_contact_ids(uuid) to service_role;
