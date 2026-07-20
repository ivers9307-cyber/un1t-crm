-- FUNNEL-PANEL — distinct-session counts per /start funnel step, for the Ads
-- dashboard's Funnel panel. Aggregates in SQL so the read is cap-safe (never
-- pulls raw funnel_events under the 1k-row select limit). security invoker +
-- fixed search_path; called from the service-role dashboard read.
create or replace function funnel_step_counts(p_location uuid, p_since timestamptz, p_funnel text default 'start')
returns table(step text, sessions bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select step, count(distinct session_id)::bigint as sessions
  from funnel_events
  where location_id = p_location and funnel = p_funnel and created_at >= p_since
  group by step
$$;
