-- 569 — agent_conversation_reviews (MIA-BOARD.4)
--
-- The passive quality signal never happened: agent_message_feedback collected
-- ZERO rows in ten weeks. The nightly reviewer (lib/agent/review.js, cron
-- /api/cron/agent-review at 03:00) replaces it: one row per agent-touched
-- conversation per day — score 1-5, machine-readable rubric flags, a one-line
-- summary and the worst agent line verbatim. Surfaced on the agent analytics
-- page; Mondays roll up into a manager digest push.
--
-- Service-only: RLS enabled with NO policies (deny-all to browser roles by
-- design — same pattern as error_events, mig 435). Reads go through the
-- MANAGER_ROLES-gated /api/agent/analytics route.

create table if not exists public.agent_conversation_reviews (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  location_id     uuid not null references public.locations(id),
  channel         text not null check (channel in ('whatsapp', 'instagram')),
  conversation_id uuid not null,
  review_date     date not null,
  score           int check (score between 1 and 5),
  flags           jsonb not null default '[]'::jsonb,
  summary         text,
  worst_quote     text,
  model           text,
  -- One review per conversation per day: reruns and races upsert-collide
  -- here and are treated as already-done.
  unique (channel, conversation_id, review_date)
);

create index if not exists agent_conversation_reviews_location_created_idx
  on public.agent_conversation_reviews (location_id, created_at desc);

alter table public.agent_conversation_reviews enable row level security;

comment on table public.agent_conversation_reviews is
  'MIA-BOARD.4 (mig 569) — nightly rubric reviews of agent-touched conversations. Service-role writes only; RLS deny-all by design. Written by /api/cron/agent-review, read via /api/agent/analytics.';

-- The cron heartbeat row, per the invariant: every vercel.json cron carries
-- one and stamps it on success.
insert into public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes)
values ('agent-review', 86400, 21600, 'Nightly rubric review of agent conversations (MIA-BOARD.4, mig 569). Runs 03:00 UTC.')
on conflict (name) do nothing;
