-- 254_whatsapp_template_events.sql
-- WA-TMPL — real-time template lifecycle: quality column on whatsapp_templates,
-- a status/quality/category audit trail, and Realtime on the templates table.

-- 1. Quality rating (from message_template_quality_update.new_quality_score).
alter table public.whatsapp_templates
  add column if not exists quality_rating text;

-- 2. Per-template audit trail — one row per real transition.
create table if not exists public.whatsapp_template_events (
  id          uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.whatsapp_templates(id) on delete cascade,
  location_id uuid references public.locations(id),   -- denormalised (codebase convention)
  kind        text not null check (kind in ('status','quality','category')),
  from_value  text,                                   -- null for status (webhook gives no prior)
  to_value    text not null,
  reason      text,                                   -- rejection reason for status events
  created_at  timestamptz not null default now()
);

create index if not exists idx_wa_template_events_template
  on public.whatsapp_template_events (template_id, created_at desc);

alter table public.whatsapp_template_events enable row level security;

-- Location-scoped through the parent template (mirrors whatsapp_broadcast_recipients).
-- NOTE: the helper lives in the `private` schema (mig 022 moved it) — public. would fail.
drop policy if exists whatsapp_template_events_via_template on public.whatsapp_template_events;
create policy whatsapp_template_events_via_template on public.whatsapp_template_events
  for all to authenticated
  using (exists (
    select 1 from public.whatsapp_templates t
     where t.id = whatsapp_template_events.template_id
       and private.auth_is_in_location(t.location_id)
  ))
  with check (exists (
    select 1 from public.whatsapp_templates t
     where t.id = whatsapp_template_events.template_id
       and private.auth_is_in_location(t.location_id)
  ));

-- 3. Realtime so the templates page live-updates (idempotent — mig 042 pattern).
do $$ begin
  alter publication supabase_realtime add table public.whatsapp_templates;
exception when duplicate_object then null; end $$;

do $$ begin
  alter publication supabase_realtime add table public.whatsapp_template_events;
exception when duplicate_object then null; end $$;
