-- RAFFLE.2 — ticket options ("3 for €10") on a raffle, set per event.
--
-- raffles.ticket_options: a JSON array of { "tickets": int >= 2,
--   "price_cents": int > 0 }, managers edit it with the raffle's name and
--   single-ticket price. Empty means singles only.
-- raffle_sales.option_label: the option a sale was priced by ("3 for €10"),
--   or null for single-ticket pricing. A snapshot: editing the options later
--   never rewrites a past sale (total_cents was already a snapshot).
--
-- sell_raffle_tickets keeps its signature (the deployed code calls it as is)
-- and now prices a quantity that matches an option at that option's price;
-- any other quantity is price × quantity, as before. CREATE OR REPLACE keeps
-- the function's ACL; the revoke/grant below restate it.
--
-- Applied via Supabase MCP against iyvtbjjxdggiadzwwvdj BEFORE the code deploys.

alter table public.raffles
  add column if not exists ticket_options jsonb not null default '[]'::jsonb;

alter table public.raffles
  drop constraint if exists raffles_ticket_options_is_array;
alter table public.raffles
  add constraint raffles_ticket_options_is_array check (jsonb_typeof(ticket_options) = 'array');

alter table public.raffle_sales
  add column if not exists option_label text;

comment on column public.raffles.ticket_options is 'RAFFLE.2: [{tickets, price_cents}] bundle prices; a matching quantity is sold at the bundle price.';
comment on column public.raffle_sales.option_label is 'RAFFLE.2: the ticket option this sale was priced by, e.g. "3 for €10"; null for single-ticket pricing.';

create or replace function public.sell_raffle_tickets(
  p_raffle_id uuid,
  p_request_id uuid,
  p_contact_id uuid,
  p_buyer_name text,
  p_buyer_email text,
  p_quantity integer,
  p_payment_method text,
  p_sold_by uuid
) returns public.raffle_sales
language plpgsql
security definer
set search_path = public
as $$
declare
  v_raffle public.raffles;
  v_sale public.raffle_sales;
  v_first integer;
  v_total integer;
  v_label text;
  v_option_price integer;
begin
  select * into v_sale from public.raffle_sales
    where raffle_id = p_raffle_id and request_id = p_request_id;
  if found then
    return v_sale;
  end if;

  select * into v_raffle from public.raffles where id = p_raffle_id for update;
  if not found then
    raise exception 'raffle_not_found';
  end if;
  if not v_raffle.sales_open then
    raise exception 'raffle_closed';
  end if;
  if p_quantity is null or p_quantity < 1 or p_quantity > 500 then
    raise exception 'bad_quantity';
  end if;

  select * into v_sale from public.raffle_sales
    where raffle_id = p_raffle_id and request_id = p_request_id;
  if found then
    return v_sale;
  end if;

  -- The cheapest option for exactly this many tickets, if there is one.
  select min((o->>'price_cents')::integer) into v_option_price
    from jsonb_array_elements(v_raffle.ticket_options) o
    where (o->>'tickets')::integer = p_quantity
      and (o->>'price_cents')::integer > 0;

  if v_option_price is not null then
    v_total := v_option_price;
    v_label := p_quantity || ' for €' || trim(to_char(v_option_price / 100.0, 'FM999990.00'));
    if v_label like '%.00' then
      v_label := left(v_label, length(v_label) - 3);
    end if;
  else
    v_total := v_raffle.ticket_price_cents * p_quantity;
    v_label := null;
  end if;

  v_first := v_raffle.next_ticket_number;

  insert into public.raffle_sales (
    raffle_id, location_id, contact_id, buyer_name, buyer_email, quantity,
    total_cents, payment_method, first_ticket, last_ticket, request_id, sold_by, option_label
  ) values (
    p_raffle_id, v_raffle.location_id, p_contact_id, p_buyer_name, p_buyer_email, p_quantity,
    v_total, p_payment_method, v_first, v_first + p_quantity - 1,
    p_request_id, p_sold_by, v_label
  ) returning * into v_sale;

  insert into public.raffle_tickets (raffle_id, sale_id, ticket_number)
    select p_raffle_id, v_sale.id, n from generate_series(v_first, v_first + p_quantity - 1) as n;

  update public.raffles set next_ticket_number = v_first + p_quantity where id = p_raffle_id;

  return v_sale;
end;
$$;

revoke execute on function public.sell_raffle_tickets(uuid, uuid, uuid, text, text, integer, text, uuid) from public, anon, authenticated;
grant execute on function public.sell_raffle_tickets(uuid, uuid, uuid, text, text, integer, text, uuid) to service_role;
