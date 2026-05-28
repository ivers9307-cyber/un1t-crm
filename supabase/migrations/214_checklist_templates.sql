-- CHECKLIST.1 — role + day-of-week checklist templates.
--
-- Per the design: each location has a grid of templates, one per
-- (role, day_of_week). When a coach has a shift assigned at the
-- location on that weekday, the matching template's items become
-- their checklist for the day (instances are created lazily in
-- CHECKLIST.2). The coach ticks items off before their shift ends;
-- a deadline-sweep cron (CHECKLIST.3) flags anything left undone
-- and pushes a notification to head coach + owners at the location.
--
-- PR 1 (this migration + the admin UI + APIs in this PR) is
-- templates only. instance tracking, mobile, and the sweep land in
-- PR 2 and PR 3.
--
-- Why store items as JSONB rather than a child table:
-- - Items are small, ordered, and edited as a unit (the admin
--   replaces the whole list when saving a template). A child table
--   would mean joins + ordering bookkeeping for no real win.
-- - The instance row (PR 2) will snapshot the items at the time of
--   generation, so even if the template changes mid-shift the
--   coach's checklist won't shift under them. JSONB makes that
--   snapshot trivial — just copy the column.
-- - Item ids are needed so we can persist tick state per-item
--   across template edits (e.g. master renames "Wipe kettlebells"
--   → "Sanitise kettlebells" without losing the tick).
--
-- Item shape (validated API-side):
--   { id: <uuid>, label: <string, 1..200 chars>, order: <int> }
--
-- Role gating: master + owner can edit any template at any of
-- their locations. PR 1 doesn't introduce a new permission key —
-- the role check is enforced in the API route.

set check_function_bodies = off;

create table public.checklist_templates (
  id              uuid primary key default gen_random_uuid(),
  location_id     uuid not null references public.locations (id) on delete cascade,

  -- The role this template applies to. CHECK enforces the same
  -- enum the profile.role column uses (mig 033 + downstream). We
  -- omit 'master' because masters are super-admin and aren't
  -- assigned shifts; templates target front-of-house roles.
  role            text not null check (role in ('staff', 'head_coach', 'manager', 'owner')),

  -- Day of week. Postgres convention: 0 = Sunday, 6 = Saturday
  -- (matches `extract(dow from <date>)`). Stored as int for cheap
  -- comparison + indexing. The admin UI renders the weekday name.
  day_of_week     int  not null check (day_of_week between 0 and 6),

  -- Human-readable template name. Lets the admin tell similar
  -- templates apart in the grid (e.g. "Saturday closer (long
  -- shift)" vs. "Saturday closer (split)"). Required so the grid
  -- isn't a sea of unnamed cells.
  name            text not null check (length(name) > 0 and length(name) <= 100),

  -- The items the coach needs to tick. JSONB array; validated
  -- API-side (length, label bounds, unique ids). Default empty
  -- so the admin can create a template and add items later.
  items           jsonb not null default '[]'::jsonb
                  check (jsonb_typeof(items) = 'array'),

  -- Soft-delete pattern. Mirrors ac_devices.enabled (mig 210):
  -- disable rather than delete so any in-flight references from
  -- PR 2's instance table stay resolvable. A disabled template
  -- means no NEW instances generate; existing instances finish.
  enabled         boolean not null default true,

  -- Audit timestamps.
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  -- One template per (location, role, day_of_week). This is the
  -- design point — the lazy-generation lookup in PR 2 wants
  -- exactly one matching row, so we constrain at the schema.
  unique (location_id, role, day_of_week)
);

create index checklist_templates_location_idx
  on public.checklist_templates (location_id);

comment on table public.checklist_templates is
  'CHECKLIST.1 — per (location, role, day_of_week) checklist '
  'templates. PR 2 will lazily generate instances per (profile, '
  'date) when the coach has a shift assignment matching the '
  'template. Item snapshot lives on the instance so template '
  'edits do not shift state under a live shift.';

comment on column public.checklist_templates.items is
  'JSONB array of { id, label, order }. Validated API-side. '
  'Snapshotted onto the instance at generation time (PR 2) so a '
  'mid-shift template edit cannot break the coach''s tick state.';

-- Touch updated_at automatically. Same shape as the issues
-- trigger from mig 213.
create or replace function public.checklist_templates_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger checklist_templates_updated_at_trg
  before update on public.checklist_templates
  for each row execute function public.checklist_templates_touch_updated_at();

-- RLS service-role-only. API routes mediate; no direct client
-- reads / writes. Mirrors issues (mig 213) and ac_devices (mig 210).
alter table public.checklist_templates enable row level security;
