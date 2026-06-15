-- 272_consultations.sql — CONSULTATIONS SP1 (consultations + photos + goals + inbody_scans)
create table public.consultations (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.contacts(id) on delete cascade,
  location_id uuid not null references public.locations(id) on delete cascade,
  consulted_at timestamptz not null default now(),
  coach_id uuid references public.profiles(id),
  notes text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_consultations_contact on public.consultations(contact_id, consulted_at desc);

create table public.consultation_photos (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.contacts(id) on delete cascade,
  location_id uuid not null references public.locations(id) on delete cascade,
  consultation_id uuid references public.consultations(id) on delete set null,
  storage_path text not null,
  taken_at timestamptz not null default now(),
  label text,
  caption text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);
create index idx_consultation_photos_contact on public.consultation_photos(contact_id, taken_at desc);

create table public.coaching_goals (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.contacts(id) on delete cascade,
  location_id uuid not null references public.locations(id) on delete cascade,
  title text not null,
  detail text,
  target_value text,
  target_date date,
  status text not null default 'open' check (status in ('open','achieved','dropped')),
  achieved_at timestamptz,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_coaching_goals_contact on public.coaching_goals(contact_id, status);

create table public.inbody_scans (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid references public.contacts(id) on delete set null,
  location_id uuid not null references public.locations(id) on delete cascade,
  source text not null default 'lookinbody',
  external_id text,
  scanned_at timestamptz not null,
  weight_kg numeric, pbf_percent numeric, smm_kg numeric, bmi numeric,
  bmr numeric, body_fat_mass_kg numeric, inbody_score numeric,
  matched_phone text,
  raw jsonb,
  created_at timestamptz not null default now(),
  unique (source, external_id)
);
create index idx_inbody_scans_contact on public.inbody_scans(contact_id, scanned_at desc);

alter table public.consultations enable row level security;
alter table public.consultation_photos enable row level security;
alter table public.coaching_goals enable row level security;
alter table public.inbody_scans enable row level security;

create policy consultations_loc on public.consultations for all to authenticated
  using (private.auth_is_in_location(location_id)) with check (private.auth_is_in_location(location_id));
create policy consultation_photos_loc on public.consultation_photos for all to authenticated
  using (private.auth_is_in_location(location_id)) with check (private.auth_is_in_location(location_id));
create policy coaching_goals_loc on public.coaching_goals for all to authenticated
  using (private.auth_is_in_location(location_id)) with check (private.auth_is_in_location(location_id));
create policy inbody_scans_loc on public.inbody_scans for all to authenticated
  using (private.auth_is_in_location(location_id)) with check (private.auth_is_in_location(location_id));

create policy coaching_goals_self on public.coaching_goals for select to public
  using (contact_id = private.auth_contact_id());
create policy consultation_photos_self on public.consultation_photos for select to public
  using (contact_id = private.auth_contact_id());
create policy inbody_scans_self on public.inbody_scans for select to public
  using (contact_id = private.auth_contact_id());

insert into storage.buckets (id, name, public) values ('consultation-photos','consultation-photos', false)
  on conflict (id) do nothing;
