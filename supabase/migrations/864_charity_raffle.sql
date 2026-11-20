-- RAFFLE.1 — a raffle on a charity event, sold in person at a till.
--
-- Four tables and one function:
--   raffles         one per event (race_event_id unique): name, ticket price,
--                   the next ticket number to hand out.
--   raffle_sales    one per purchase at the till. contact_id is set for a
--                   buyer who is already a CRM contact; a guest is stored here
--                   only (buyer_name + buyer_email) and NO contact is created.
--                   request_id is the till's idempotency key (a double tap or
--                   a retried request returns the same sale).
--   raffle_tickets  one row per ticket number, unique per raffle.
--   raffle_draws    one per prize drawn; ticket_id unique, so a ticket wins
--                   once. A draw is never deleted: "not claimed" is a stamp,
--                   and the ticket stays out of later draws.
--   sell_raffle_tickets()  sells atomically: locks the raffle row, takes the
--                   next block of numbers, writes the sale and its tickets.
--
-- Raffle money is its own total; it is never added to or matched with
-- donations.
--
-- Service-role only: every reader and writer is a staff route on the service
-- role. No client session reads or writes these tables, and no policy is
-- created.
--
-- Applied via Supabase MCP against iyvtbjjxdggiadzwwvdj BEFORE the code deploys.

create table if not exists public.raffles (
  id uuid primary key default gen_random_uuid(),
  race_event_id uuid not null unique references public.race_events(id) on delete restrict,
  location_id uuid not null references public.locations(id) on delete cascade,
  name text not null,
  ticket_price_cents integer not null check (ticket_price_cents > 0),
  currency text not null default 'EUR',
  sales_open boolean not null default true,
  email_subject text,
  email_intro text,
  next_ticket_number integer not null default 1 check (next_ticket_number > 0),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.raffle_sales (
  id uuid primary key default gen_random_uuid(),
  raffle_id uuid not null references public.raffles(id) on delete restrict,
  location_id uuid not null references public.locations(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  buyer_name text not null,
  buyer_email text not null,
  quantity integer not null check (quantity between 1 and 500),
  total_cents integer not null check (total_cents > 0),
  payment_method text not null check (payment_method in ('cash', 'card')),
  first_ticket integer not null,
  last_ticket integer not null,
  request_id uuid not null,
  sold_by uuid references public.profiles(id) on delete set null,
  voided_at timestamptz,
  voided_by uuid references public.profiles(id) on delete set null,
  void_reason text,
  email_status text check (email_status in ('sent', 'suppressed', 'failed')),
  email_sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique (raffle_id, request_id)
);

create index if not exists idx_raffle_sales_raffle on public.raffle_sales (raffle_id, created_at desc);
create index if not exists idx_raffle_sales_contact on public.raffle_sales (contact_id) where contact_id is not null;

create table if not exists public.raffle_tickets (
  id uuid primary key default gen_random_uuid(),
  raffle_id uuid not null references public.raffles(id) on delete restrict,
  sale_id uuid not null references public.raffle_sales(id) on delete restrict,
  ticket_number integer not null check (ticket_number > 0),
  created_at timestamptz not null default now(),
  unique (raffle_id, ticket_number)
);

create index if not exists idx_raffle_tickets_sale on public.raffle_tickets (sale_id);

create table if not exists public.raffle_draws (
  id uuid primary key default gen_random_uuid(),
  raffle_id uuid not null references public.raffles(id) on delete restrict,
  prize_name text not null,
  ticket_id uuid not null unique references public.raffle_tickets(id) on delete restrict,
  drawn_by uuid references public.profiles(id) on delete set null,
  drawn_at timestamptz not null default now(),
  unclaimed_at timestamptz,
  unclaimed_by uuid references public.profiles(id) on delete set null,
  unclaimed_note text
);

create index if not exists idx_raffle_draws_raffle on public.raffle_draws (raffle_id, drawn_at);

create or replace trigger trg_raffles_updated_at before update on public.raffles
  for each row execute function update_updated_at();

alter table public.raffles enable row level security;
alter table public.raffle_sales enable row level security;
alter table public.raffle_tickets enable row level security;
alter table public.raffle_draws enable row level security;
revoke all on public.raffles from anon, authenticated, public;
revoke all on public.raffle_sales from anon, authenticated, public;
revoke all on public.raffle_tickets from anon, authenticated, public;
revoke all on public.raffle_draws from anon, authenticated, public;

comment on table public.raffles is 'RAFFLE.1: one raffle per charity event, sold in person. Service-role only.';
comment on table public.raffle_sales is 'RAFFLE.1: one row per till purchase. A guest buyer lives here only; no contact is created. Service-role only.';
comment on table public.raffle_tickets is 'RAFFLE.1: one row per ticket number, unique per raffle. Service-role only.';
comment on table public.raffle_draws is 'RAFFLE.1: one row per prize drawn; never deleted (not claimed is a stamp). Service-role only.';

-- The till's sale, in one transaction. Idempotent on (raffle, request_id).
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

  -- A concurrent retry of the same request may have committed while we
  -- waited for the lock.
  select * into v_sale from public.raffle_sales
    where raffle_id = p_raffle_id and request_id = p_request_id;
  if found then
    return v_sale;
  end if;

  v_first := v_raffle.next_ticket_number;

  insert into public.raffle_sales (
    raffle_id, location_id, contact_id, buyer_name, buyer_email, quantity,
    total_cents, payment_method, first_ticket, last_ticket, request_id, sold_by
  ) values (
    p_raffle_id, v_raffle.location_id, p_contact_id, p_buyer_name, p_buyer_email, p_quantity,
    v_raffle.ticket_price_cents * p_quantity, p_payment_method, v_first, v_first + p_quantity - 1,
    p_request_id, p_sold_by
  ) returning * into v_sale;

  insert into public.raffle_tickets (raffle_id, sale_id, ticket_number)
    select p_raffle_id, v_sale.id, n from generate_series(v_first, v_first + p_quantity - 1) as n;

  update public.raffles set next_ticket_number = v_first + p_quantity where id = p_raffle_id;

  return v_sale;
end;
$$;

revoke execute on function public.sell_raffle_tickets(uuid, uuid, uuid, text, text, integer, text, uuid) from public, anon, authenticated;
grant execute on function public.sell_raffle_tickets(uuid, uuid, uuid, text, text, integer, text, uuid) to service_role;
