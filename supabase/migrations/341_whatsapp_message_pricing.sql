-- WA-COST — persist Meta's per-message pricing fields (PMP, July 2025+) from
-- status webhooks so spend is attributable locally: category
-- (marketing/utility/authentication/service/referral_conversion), type
-- (regular/free_customer_service/free_entry_point) and billability.
alter table whatsapp_messages add column if not exists pricing_category text;
alter table whatsapp_messages add column if not exists pricing_type text;
alter table whatsapp_messages add column if not exists billable boolean;

comment on column whatsapp_messages.pricing_category is
  'Meta PMP pricing category from the sent-status webhook (mig 341)';
comment on column whatsapp_messages.pricing_type is
  'Meta PMP pricing type — regular / free_customer_service / free_entry_point (mig 341)';
comment on column whatsapp_messages.billable is
  'Meta PMP billable flag from the sent-status webhook (mig 341)';

-- GROUP BY rollup (supabase-js cannot aggregate; 1k-row cap forbids row fetch).
-- SECURITY INVOKER (default): callable meaningfully only by the service role.
create or replace function whatsapp_spend_rollup(p_location_id uuid, p_since timestamptz)
returns table(pricing_category text, pricing_type text, billable boolean, messages bigint)
language sql stable as $$
  select m.pricing_category, m.pricing_type, m.billable, count(*)::bigint as messages
  from whatsapp_messages m
  where m.location_id = p_location_id
    and m.direction = 'outbound'
    and m.created_at >= p_since
    and m.pricing_category is not null
  group by 1, 2, 3
  order by 4 desc
$$;
