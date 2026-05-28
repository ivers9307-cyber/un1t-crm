-- CHECKLIST.2 — per-(profile, date) checklist instances generated
-- lazily when a coach views their checklist on a day they have a
-- shift assigned that matches a template.
--
-- Lifecycle:
--   pending    → created, some/no items ticked, deadline_at in future
--   complete   → every item in the snapshot has a tick recorded
--                (auto-transition when the last item is checked)
--   incomplete → deadline_at passed without complete (PR 3 cron sets
--                this and notifies head coach + owners)
--
-- The items snapshot lives on the row. We copy the template's items
-- jsonb at the moment of generation so a mid-shift template edit
-- can't shift state under the coach. Tick state is keyed by item
-- id, so renaming a label in the template after the fact still
-- preserves the tick (and missing items just stay 'unticked' on
-- old instances).
--
-- Unique (profile_id, date, template_id) — one instance per coach
-- per day per template. If a coach somehow holds two roles at one
-- location (rare but possible), they get one instance per matching
-- template. PR 2's mobile view aggregates them into a single
-- 'Today's checklist' surface.

set check_function_bodies = off;

create table public.checklist_instances (
  id              uuid primary key default gen_random_uuid(),

  template_id     uuid not null references public.checklist_templates (id) on delete restrict,
  profile_id      uuid not null references public.profiles (id) on delete cascade,
  location_id     uuid not null references public.locations (id) on delete cascade,

  -- Calendar date in the location's timezone (resolved at
  -- generation time). Drives the matching template lookup
  -- (extract(dow from date) → template.day_of_week) and the
  -- "today's checklist" filter on the mobile.
  date            date not null,

  -- Status. Same enum as scoped in the table header.
  status          text not null default 'pending'
                  check (status in ('pending', 'complete', 'incomplete')),

  -- Snapshot of the template's items at generation. Array of
  -- { id, label, order } — same shape as checklist_templates.items.
  -- Validated API-side when the instance is created (PR 2 lib).
  items           jsonb not null default '[]'::jsonb
                  check (jsonb_typeof(items) = 'array'),

  -- Per-item tick state. Object keyed by item id:
  --   { "<item_id>": { "checked_at": "...", "checked_by": "<profile_id>" } }
  -- Empty {} means nothing ticked yet. PR 3's cron looks at the
  -- key set vs the items snapshot to decide complete vs
  -- incomplete.
  items_checked   jsonb not null default '{}'::jsonb
                  check (jsonb_typeof(items_checked) = 'object'),

  -- Deadline. End of the coach's latest shift block today at
  -- this location (with override applied). Set at generation;
  -- can shift if the schedule is edited mid-day (caller updates
  -- on the next view). PR 3 cron uses this to find expired
  -- pending instances.
  deadline_at     timestamptz not null,

  -- Set when the last item is ticked or the cron force-completes.
  completed_at    timestamptz,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  unique (profile_id, date, template_id)
);

create index checklist_instances_profile_date_idx
  on public.checklist_instances (profile_id, date desc);

-- Used by PR 3's deadline-sweep cron.
create index checklist_instances_deadline_idx
  on public.checklist_instances (deadline_at)
  where status = 'pending';

-- Used by the location-level non-compliance dashboard in PR 3.
create index checklist_instances_location_date_idx
  on public.checklist_instances (location_id, date desc, status);

comment on table public.checklist_instances is
  'CHECKLIST.2 — per (profile, date) checklist instances generated '
  'lazily when a coach views their checklist on a day with a '
  'matching shift assignment and template. items is a snapshot of '
  'the template at generation time; items_checked keys it by item id.';

comment on column public.checklist_instances.items_checked is
  'Tick state keyed by item id: { "<item_id>": { checked_at, checked_by } }. '
  'Missing keys are unticked. PR 2 auto-transitions status to complete when '
  'every item.id in the items snapshot has a key here.';

-- updated_at trigger. Same shape as checklist_templates.
create or replace function public.checklist_instances_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger checklist_instances_updated_at_trg
  before update on public.checklist_instances
  for each row execute function public.checklist_instances_touch_updated_at();

-- RLS service-role-only. API routes mediate; mobile reads + writes
-- go through /api/mobile/checklists.
alter table public.checklist_instances enable row level security;
