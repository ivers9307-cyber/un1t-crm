-- EQUIP-MAINT.1 — equipment register, per-type inspection checklists,
-- and the inspection record.
--
-- Design: docs/superpowers/specs/2026-07-31-equipment-maintenance-inspections-design.md
--
-- Faults raised by an inspection go into the EXISTING issues table
-- (mig 213) via the new issues.equipment_id column — one owner inbox,
-- and claim/resolve/close + the notify_issue_* pushes already work.
-- The checklist tables (migs 214/215) are deliberately NOT extended:
-- their uniqueness constraints encode a person-and-date design, and an
-- inspection belongs to an asset on a cycle.
--
-- location_id is `on delete restrict` on all four tables, matching
-- issues (mig 213) rather than checklist_templates (mig 214, cascade).
-- Cascade would be unsafe: deleting a location would cascade into both
-- equipment_types and equipment, and the restrict FK between them could
-- fire mid-cascade.
--
-- RLS is service-role-only on all four. API routes mediate every read
-- and write, same as issues and the checklist tables.

set check_function_bodies = off;

-- ====================================================================
-- equipment_settings — one row per location. No row (or enabled=false)
-- means the feature is dormant there, so this migration is inert until
-- an operator switches a location on.
-- ====================================================================

create table public.equipment_settings (
  location_id            uuid primary key references public.locations (id) on delete restrict,

  -- Postgres dow convention: 0 = Sunday .. 6 = Saturday. Same
  -- convention as checklist_templates.day_of_week (mig 214) so the two
  -- features agree on what "Tuesday" means.
  inspection_day_of_week int     not null default 2 check (inspection_day_of_week between 0 and 6),

  enabled                boolean not null default false,

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

comment on table public.equipment_settings is
  'EQUIP-MAINT.1 — per-location inspection weekday + feature switch. '
  'No row or enabled=false means the feature is dormant at that location.';

-- ====================================================================
-- equipment_types — the checklist + interval, inherited by assets.
-- ====================================================================

create table public.equipment_types (
  id             uuid primary key default gen_random_uuid(),
  location_id    uuid not null references public.locations (id) on delete restrict,

  name           text not null check (length(name) > 0 and length(name) <= 100),

  -- JSONB array of { id, label, order } — the SAME shape
  -- checklist_templates.items uses (mig 214), validated API-side for
  -- bounds and unique ids. Stable per-item uuids mean renaming a label
  -- preserves tick history on past inspections.
  items          jsonb not null default '[]'::jsonb
                 check (jsonb_typeof(items) = 'array'),

  -- Interval in WEEKS, not days. Inspections happen on a fixed weekday,
  -- so weeks are the only unit where the next due date always lands on
  -- that weekday without drift. 1=weekly, 4=four-weekly, 13=quarterly.
  interval_weeks int not null check (interval_weeks between 1 and 52),

  -- Soft delete, mirroring checklist_templates.enabled (mig 214):
  -- disabling stops new assets adopting it without orphaning existing
  -- assets or inspection history.
  enabled        boolean not null default true,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  unique (location_id, name)
);

create index equipment_types_location_idx
  on public.equipment_types (location_id)
  where enabled;

comment on table public.equipment_types is
  'EQUIP-MAINT.1 — per-location equipment type carrying the inspection '
  'checklist (items jsonb) and the interval in weeks. Assets inherit; '
  'there is no per-asset override.';

-- ====================================================================
-- equipment — the assets themselves.
-- ====================================================================

create table public.equipment (
  id                       uuid primary key default gen_random_uuid(),
  location_id              uuid not null references public.locations (id) on delete restrict,

  -- restrict: a type with assets on it cannot be deleted. Operators
  -- disable a type instead (equipment_types.enabled).
  type_id                  uuid not null references public.equipment_types (id) on delete restrict,

  name                     text not null check (length(name) > 0 and length(name) <= 100),

  asset_tag                text check (asset_tag is null or length(asset_tag) <= 50),
  serial_number            text check (serial_number is null or length(serial_number) <= 100),
  manufacturer             text check (manufacturer is null or length(manufacturer) <= 100),
  zone                     text check (zone is null or length(zone) <= 100),
  purchase_date            date,
  notes                    text check (notes is null or length(notes) <= 2000),

  status                   text not null default 'in_service'
                           check (status in ('in_service', 'out_of_service', 'retired')),

  -- The issue that took this asset off the floor, if any. Resolving
  -- THAT issue is what returns the asset to service (PR 2 hook).
  out_of_service_issue_id  uuid references public.issues (id) on delete set null,

  -- The driving column. Set on create to the next occurrence of the
  -- location's inspection weekday (or an operator-supplied first-due
  -- date); rolled forward on each submitted inspection.
  next_due_on              date not null,
  last_inspected_on        date,

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

-- THIS INDEX IS THE DUE LIST. Nothing is pre-generated; "what's due"
-- is one indexed comparison, so there are no instance rows to orphan
-- when kit is retired or re-typed.
create index equipment_due_idx
  on public.equipment (location_id, next_due_on)
  where status <> 'retired';

create index equipment_type_idx
  on public.equipment (type_id);

create unique index equipment_asset_tag_idx
  on public.equipment (location_id, asset_tag)
  where asset_tag is not null;

comment on table public.equipment is
  'EQUIP-MAINT.1 — individually tracked studio assets (~30-80 per '
  'location). Consumables (kettlebells, mats, bands) are deliberately '
  'not tracked here. equipment_due_idx is the due list.';

-- ====================================================================
-- equipment_inspections — the record of a run. Written by PR 2; the
-- table lands here so PR 1 and PR 2 do not both ship DDL.
-- ====================================================================

create table public.equipment_inspections (
  id            uuid primary key default gen_random_uuid(),
  location_id   uuid not null references public.locations (id) on delete restrict,

  -- restrict, so the compliance log cannot be holed by deleting kit.
  -- Operators retire assets instead (status = 'retired').
  equipment_id  uuid not null references public.equipment (id) on delete restrict,
  type_id       uuid references public.equipment_types (id) on delete set null,
  inspector_id  uuid references public.profiles (id) on delete set null,

  -- The cycle this run satisfies. Roll-forward is measured from HERE,
  -- not from the submission date, so a late inspection does not drag
  -- the whole schedule permanently later.
  due_on        date not null,

  -- Snapshot of the type's items taken at draft creation, so editing a
  -- type mid-walk-round cannot shift state under the inspector. Same
  -- protection checklist_instances provides (mig 215).
  items         jsonb not null default '[]'::jsonb
                check (jsonb_typeof(items) = 'array'),

  -- { "<item_id>": { state: 'pass'|'fail', note, at, by } }
  results       jsonb not null default '{}'::jsonb
                check (jsonb_typeof(results) = 'object'),

  status        text not null default 'draft'
                check (status in ('draft', 'submitted')),
  submitted_at  timestamptz,

  issue_id      uuid references public.issues (id) on delete set null,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- One inspection per asset per cycle. This constraint is the
  -- idempotency guard against a double-submit race.
  unique (equipment_id, due_on)
);

create index equipment_inspections_equipment_idx
  on public.equipment_inspections (equipment_id, due_on desc);

create index equipment_inspections_log_idx
  on public.equipment_inspections (location_id, submitted_at desc)
  where status = 'submitted';

comment on table public.equipment_inspections is
  'EQUIP-MAINT.1 — one row per inspection run. items is a snapshot at '
  'draft creation; results keys it by item id. unique(equipment_id, '
  'due_on) is the double-submit guard.';

-- ====================================================================
-- issues.equipment_id — the ONLY change to an existing table.
-- ====================================================================

alter table public.issues
  add column if not exists equipment_id uuid references public.equipment (id) on delete set null;

create index if not exists issues_equipment_idx
  on public.issues (equipment_id)
  where equipment_id is not null;

comment on column public.issues.equipment_id is
  'EQUIP-MAINT.1 — set when the issue was raised by a failed equipment '
  'inspection. Null for ordinary staff-reported issues.';

-- ====================================================================
-- updated_at triggers — same shape as issues (mig 213).
-- ====================================================================

create or replace function public.equipment_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger equipment_settings_updated_at_trg
  before update on public.equipment_settings
  for each row execute function public.equipment_touch_updated_at();

create trigger equipment_types_updated_at_trg
  before update on public.equipment_types
  for each row execute function public.equipment_touch_updated_at();

create trigger equipment_updated_at_trg
  before update on public.equipment
  for each row execute function public.equipment_touch_updated_at();

create trigger equipment_inspections_updated_at_trg
  before update on public.equipment_inspections
  for each row execute function public.equipment_touch_updated_at();

-- ====================================================================
-- RLS — service-role only on all four. Mirrors issues (mig 213),
-- checklist_templates (214) and checklist_instances (215).
-- ====================================================================

alter table public.equipment_settings    enable row level security;
alter table public.equipment_types       enable row level security;
alter table public.equipment             enable row level security;
alter table public.equipment_inspections enable row level security;
