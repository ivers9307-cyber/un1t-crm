-- 291_presentations.sql — PRESENT slideshow feature.
-- Standalone laptop-driven multi-screen slideshow. Decks of uploaded slide
-- images; a public view_token drives the viewer; a version counter is the
-- viewer's change signal.

create table if not exists public.presentations (
  id            uuid primary key default gen_random_uuid(),
  location_id   uuid not null references public.locations(id) on delete cascade,
  title         text not null,
  view_token    uuid not null unique default gen_random_uuid(),
  current_index int  not null default 0,
  version       int  not null default 0,
  created_by    uuid references public.profiles(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists public.presentation_slides (
  id              uuid primary key default gen_random_uuid(),
  presentation_id uuid not null references public.presentations(id) on delete cascade,
  location_id     uuid not null references public.locations(id) on delete cascade,
  position        int  not null,
  image_path      text not null,
  created_at      timestamptz not null default now()
);

create index if not exists idx_presentations_location on public.presentations(location_id);
create index if not exists idx_presentation_slides_deck on public.presentation_slides(presentation_id, position);

alter table public.presentations enable row level security;
alter table public.presentation_slides enable row level security;

-- Location-scoped read/write for authenticated staff (defence-in-depth; the
-- API routes use the service-role client and are the real gate). The public
-- viewer never uses this client — it reads via a service-role API keyed on
-- view_token.
create policy "presentations_location_scoped" on public.presentations
  for all to authenticated
  using (private.auth_is_in_location(location_id))
  with check (private.auth_is_in_location(location_id));

create policy "presentation_slides_location_scoped" on public.presentation_slides
  for all to authenticated
  using (private.auth_is_in_location(location_id))
  with check (private.auth_is_in_location(location_id));

-- Public storage bucket for slide images (mirrors tv-content). Public read;
-- writes happen server-side with the service-role client (bypasses RLS).
insert into storage.buckets (id, name, public)
values ('presentation-slides', 'presentation-slides', true)
on conflict (id) do nothing;
