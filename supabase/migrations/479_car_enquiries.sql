-- 479 — car_enquiries: public enquiries from the ccfautos.com
-- coming-soon site (CCF-WEB.1, spec 2026-08-04). Inserted ONLY by the
-- service-role route /api/public/ccf-enquiry; staff read arrives with
-- the future cars-section UI (service-role routes too). RLS is enabled
-- with NO policies on purpose: anon/authenticated get nothing — the
-- CRM's Supabase project is shared with the customer champ-app, so an
-- authenticated-wide SELECT policy would let gym members read car
-- enquiries via direct supabase-js.

create table car_enquiries (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text not null,
  phone text not null,
  email text,
  message text,
  source text not null default 'ccfautos.com',
  status text not null default 'new'
);

alter table car_enquiries enable row level security;
