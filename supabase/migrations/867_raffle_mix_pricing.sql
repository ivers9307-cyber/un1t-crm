-- RAFFLE.4 — price any quantity as the cheapest mix of ticket options and
-- single tickets (Richard, 20 Nov: 20 tickets with "10 for €25" on sale is a
-- multiple of a deal, not 20 singles).
--
-- sell_raffle_tickets keeps its signature (the deployed code calls it as is).
-- The search is the one priceForQuantity (src/lib/raffle-format.js) runs, unit
-- for unit, so the till screen, the online card and the charge always agree:
--   units = [1 ticket at the single price] then the options with 2+ tickets
--   and a price, ordered by tickets then price; cost[n] keeps the FIRST unit
--   that reaches its lowest cost (strictly cheaper replaces).
-- option_label names the deals used, largest first ("2 × 10 for €25",
-- "5 for €12 + 2 singles"), and is null when only single tickets were used.
-- issue_raffle_order_tickets (online) is unchanged: it records the amount the
-- buyer actually paid, priced by the same rule in the buy route.
--
-- Applied via Supabase MCP against iyvtbjjxdggiadzwwvdj BEFORE the code deploys.

create or replace function public.raffle_mix_price(p_raffle public.raffles, p_quantity integer)
returns table (total_cents integer, label text)
language plpgsql
stable
set search_path = public
as $$
declare
  v_t integer[];
  v_p integer[];
  v_cost bigint[];
  v_pick integer[];
  v_counts integer[];
  v_n integer;
  v_i integer;
  v_parts text[] := '{}';
  v_deal text;
  v_price text;
begin
  -- Units: the single ticket first, then the options in ticket order.
  v_t := array[1];
  v_p := array[p_raffle.ticket_price_cents];
  select v_t || coalesce(array_agg(t order by t, p), '{}'), v_p || coalesce(array_agg(p order by t, p), '{}')
    into v_t, v_p
    from (
      select (o->>'tickets')::integer as t, (o->>'price_cents')::integer as p
        from jsonb_array_elements(p_raffle.ticket_options) o
       where (o->>'tickets')::integer >= 2 and (o->>'price_cents')::integer > 0
    ) opts;

  -- cost[n + 1] / pick[n + 1]: Postgres arrays start at 1.
  v_cost := array_fill(null::bigint, array[p_quantity + 1]);
  v_pick := array_fill(0, array[p_quantity + 1]);
  v_cost[1] := 0;
  for v_n in 1..p_quantity loop
    for v_i in 1..array_length(v_t, 1) loop
      if v_t[v_i] <= v_n and v_cost[v_n - v_t[v_i] + 1] is not null
         and (v_cost[v_n + 1] is null or v_cost[v_n - v_t[v_i] + 1] + v_p[v_i] < v_cost[v_n + 1]) then
        v_cost[v_n + 1] := v_cost[v_n - v_t[v_i] + 1] + v_p[v_i];
        v_pick[v_n + 1] := v_i;
      end if;
    end loop;
  end loop;

  v_counts := array_fill(0, array[array_length(v_t, 1)]);
  v_n := p_quantity;
  while v_n > 0 loop
    v_i := v_pick[v_n + 1];
    v_counts[v_i] := v_counts[v_i] + 1;
    v_n := v_n - v_t[v_i];
  end loop;

  for v_i in reverse array_length(v_t, 1)..2 loop
    if v_counts[v_i] > 0 then
      v_price := case when v_p[v_i] % 100 = 0 then (v_p[v_i] / 100)::text
                      else to_char(v_p[v_i] / 100.0, 'FM999990.00') end;
      v_deal := v_t[v_i] || ' for €' || v_price;
      v_parts := v_parts || (case when v_counts[v_i] > 1 then v_counts[v_i] || ' × ' || v_deal else v_deal end);
    end if;
  end loop;
  if array_length(v_parts, 1) is not null and v_counts[1] > 0 then
    v_parts := v_parts || (v_counts[1] || ' single' || case when v_counts[1] = 1 then '' else 's' end);
  end if;

  total_cents := v_cost[p_quantity + 1]::integer;
  label := case when array_length(v_parts, 1) is null then null else array_to_string(v_parts, ' + ') end;
  return next;
end;
$$;

revoke execute on function public.raffle_mix_price(public.raffles, integer) from public, anon, authenticated;
grant execute on function public.raffle_mix_price(public.raffles, integer) to service_role;

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

  select m.total_cents, m.label into v_total, v_label from public.raffle_mix_price(v_raffle, p_quantity) m;

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
