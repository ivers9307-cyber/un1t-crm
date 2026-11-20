-- RAFFLE.3 — raffle tickets bought online on the public event page.
--
--   raffles.online_enabled / online_closes_at: the manager's switch and the
--     moment online sales stop (the draw is after it). Both off/null = no card
--     on the event page.
--   raffle_orders: one row per online checkout, the payment's lifecycle
--     (the shape of donations, mig 765):
--       awaiting_payment -> paid | failed | expired; paid -> refunded.
--     No contact_id: an online buyer is a guest, exactly like the till.
--     sale_id is set when the tickets are issued; email_claimed_at is the
--     send-once claim for the ticket email.
--   raffle_sales.channel: 'till' (every sale before this) or 'online'.
--   issue_raffle_order_tickets(order): numbers a PAID order's tickets, once.
--     It ignores sales_open and the closing time (the money was taken) and
--     records the amount actually paid.
--
-- Service-role only, like every raffle table and function.
-- Applied via Supabase MCP against iyvtbjjxdggiadzwwvdj BEFORE the code deploys.

alter table public.raffles
  add column if not exists online_enabled boolean not null default false,
  add column if not exists online_closes_at timestamptz;

alter table public.raffle_sales
  add column if not exists channel text not null default 'till';
alter table public.raffle_sales
  drop constraint if exists raffle_sales_channel_check;
alter table public.raffle_sales
  add constraint raffle_sales_channel_check check (channel in ('till', 'online'));

create table if not exists public.raffle_orders (
  id uuid primary key default gen_random_uuid(),
  raffle_id uuid not null references public.raffles(id) on delete restrict,
  race_event_id uuid not null references public.race_events(id) on delete restrict,
  location_id uuid not null references public.locations(id) on delete cascade,
  buyer_name text not null,
  buyer_email text not null,
  quantity integer not null check (quantity between 1 and 50),
  amount_cents integer not null check (amount_cents > 0),
  currency text not null default 'EUR',
  option_label text,
  status text not null default 'awaiting_payment'
    check (status in ('awaiting_payment', 'paid', 'failed', 'expired', 'refunded')),
  payment_provider text,
  payment_provider_ref text,
  payment_checkout_token text,
  payment_checkout_url text,
  paid_at timestamptz,
  sale_id uuid references public.raffle_sales(id) on delete restrict,
  email_claimed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_raffle_orders_raffle_status on public.raffle_orders (raffle_id, status);
create unique index if not exists idx_raffle_orders_provider_ref on public.raffle_orders (payment_provider_ref)
  where payment_provider_ref is not null;
create index if not exists idx_raffle_orders_awaiting on public.raffle_orders (created_at)
  where status = 'awaiting_payment';

create or replace trigger trg_raffle_orders_updated_at before update on public.raffle_orders
  for each row execute function update_updated_at();

alter table public.raffle_orders enable row level security;
revoke all on public.raffle_orders from anon, authenticated, public;

comment on table public.raffle_orders is 'RAFFLE.3: one row per online raffle checkout on the event page. No contact is created. Service-role only.';
comment on column public.raffle_orders.email_claimed_at is 'RAFFLE.3: send-once claim for the ticket email (compare-and-set on null).';
comment on column public.raffles.online_closes_at is 'RAFFLE.3: online sales stop at this moment; null with online_enabled means no closing time.';

create or replace function public.issue_raffle_order_tickets(p_order_id uuid)
returns public.raffle_sales
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.raffle_orders;
  v_raffle public.raffles;
  v_sale public.raffle_sales;
  v_first integer;
begin
  select * into v_order from public.raffle_orders where id = p_order_id for update;
  if not found then
    raise exception 'raffle_order_not_found';
  end if;
  if v_order.status <> 'paid' then
    raise exception 'raffle_order_not_paid';
  end if;
  if v_order.sale_id is not null then
    select * into v_sale from public.raffle_sales where id = v_order.sale_id;
    return v_sale;
  end if;

  select * into v_raffle from public.raffles where id = v_order.raffle_id for update;
  v_first := v_raffle.next_ticket_number;

  insert into public.raffle_sales (
    raffle_id, location_id, contact_id, buyer_name, buyer_email, quantity,
    total_cents, payment_method, first_ticket, last_ticket, request_id, sold_by,
    option_label, channel
  ) values (
    v_order.raffle_id, v_raffle.location_id, null, v_order.buyer_name, v_order.buyer_email, v_order.quantity,
    v_order.amount_cents, 'card', v_first, v_first + v_order.quantity - 1, v_order.id, null,
    v_order.option_label, 'online'
  ) returning * into v_sale;

  insert into public.raffle_tickets (raffle_id, sale_id, ticket_number)
    select v_order.raffle_id, v_sale.id, n from generate_series(v_first, v_first + v_order.quantity - 1) as n;

  update public.raffles set next_ticket_number = v_first + v_order.quantity where id = v_order.raffle_id;
  update public.raffle_orders set sale_id = v_sale.id where id = v_order.id;

  return v_sale;
end;
$$;

revoke execute on function public.issue_raffle_order_tickets(uuid) from public, anon, authenticated;
grant execute on function public.issue_raffle_order_tickets(uuid) to service_role;
