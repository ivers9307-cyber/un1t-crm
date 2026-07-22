-- 436 — agent_decisions: persist WHY Mia replied or stayed silent (FEAT-AGENT-TRACE.1)
--
-- shouldAgentReply() already computes a rich reason (disabled / agent_paused /
-- handed_off / human_owned / not_in_test_allowlist / quiet_hours /
-- unsupported_type / empty / auto_reply / ok) and runChannelAgent console-logs
-- the "no-reply" reason (added after the 2026-06-12 incident that took hours to
-- diagnose because nothing said WHY). This table persists that decision so it's
-- queryable + surfaceable, not just a transient log line.
--
-- Polymorphic conversation_id (whatsapp_conversations OR instagram_conversations
-- by `channel`), so no FK. Service-only: writes are service-role; RLS enabled
-- with no policy = deny-all to browser roles (same pattern as the webhook queues
-- and error_events; the advisor INFO is intended).

create table if not exists public.agent_decisions (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  channel         text not null,          -- 'whatsapp' | 'instagram'
  conversation_id uuid,
  contact_id      uuid,
  location_id     uuid,
  decision        text not null,          -- 'reply' | 'silent'
  reason          text                    -- the shouldAgentReply / parseAgentResponse reason
);

create index if not exists agent_decisions_conversation_idx
  on public.agent_decisions (conversation_id, created_at desc);
create index if not exists agent_decisions_location_created_idx
  on public.agent_decisions (location_id, created_at desc);

alter table public.agent_decisions enable row level security;

comment on table public.agent_decisions is
  'FEAT-AGENT-TRACE.1 (mig 436) — one row per agent turn: why Mia replied or stayed silent. Service-role writes only (RLS deny-all to browser roles by design). Read via /api/agent/decisions for the inbox decision-trace.';
