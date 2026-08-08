-- OFFERS.1 — weekend "lock in" sale: offers catalogue + purchases.
-- Both tables are service-role-surface only (public pages and staff UI go
-- through /api routes); RLS is enabled with a single authenticated SELECT
-- and no client write policies.

create table sale_offers (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references locations(id),
  slug text not null unique,
  category text not null check (category in ('membership','class_pack')),
  name text not null,
  bonus_headline text not null,
  description text not null default '',
  price_cents integer not null check (price_cents > 0),
  currency text not null default 'EUR',
  active boolean not null default true,
  starts_at timestamptz not null default now(),
  ends_at timestamptz not null,
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table sale_offers enable row level security;
create policy sale_offers_select on sale_offers
  for select to authenticated using (true);

create table offer_purchases (
  id uuid primary key default gen_random_uuid(),
  offer_id uuid not null references sale_offers(id),
  location_id uuid not null references locations(id),
  buyer_name text not null,
  buyer_email text not null,
  buyer_phone text not null default '',
  contact_id uuid references contacts(id),
  revolut_order_id text not null unique,
  amount_cents integer not null,
  currency text not null default 'EUR',
  state text not null default 'created'
    check (state in ('created','paid','failed','cancelled')),
  paid_at timestamptz,
  fulfilled_at timestamptz,
  fulfilled_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index offer_purchases_state_loc on offer_purchases (state, location_id);
create index offer_purchases_offer on offer_purchases (offer_id);
create index offer_purchases_contact on offer_purchases (contact_id);
create index offer_purchases_fulfilled_by on offer_purchases (fulfilled_by);
alter table offer_purchases enable row level security;
create policy offer_purchases_select on offer_purchases
  for select to authenticated using (true);

-- Seed the August sale (Stillorgan). Editable later via SQL without deploys.
insert into sale_offers
  (location_id, slug, category, name, bonus_headline, description, price_cents, ends_at, sort)
values
  ('a0000000-0000-0000-0000-000000000001','3-month-membership','membership','3 Month Membership','+2 WEEKS FREE','Three months of unlimited coached training, with an extra two weeks on the house. Includes 100 euro off.',49700,'2026-08-11 23:59:59+01',1),
  ('a0000000-0000-0000-0000-000000000001','6-month-membership','membership','6 Month Membership','+1 MONTH FREE','Six months of unlimited coached training, with a full extra month added automatically. Includes 100 euro off.',104400,'2026-08-11 23:59:59+01',2),
  ('a0000000-0000-0000-0000-000000000001','1-year-membership','membership','1 Year Membership','+6 WEEKS FREE','A full year of unlimited coached training, with six extra weeks for committing to the year. Includes 100 euro off.',206800,'2026-08-11 23:59:59+01',3),
  ('a0000000-0000-0000-0000-000000000001','30-class-pack','class_pack','30 Class Pack','+10 CLASSES FREE','Buy 30 classes, train on 40. Our biggest class pack bonus of the sale.',51000,'2026-08-11 23:59:59+01',4),
  ('a0000000-0000-0000-0000-000000000001','20-class-pack','class_pack','20 Class Pack','+5 CLASSES FREE','Buy 20 classes, train on 25. A full extra week of sessions, free.',38000,'2026-08-11 23:59:59+01',5);
