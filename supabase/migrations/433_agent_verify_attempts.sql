-- AGENT-VERIFY-HANDOFF.1 — track consecutive failed identity-verification
-- attempts per conversation so Mia can auto-hand-off after N (default 2)
-- instead of looping the customer on the email+surname quiz.
--
-- Incremented in the agent auto-reply loop on each verify_identity failure,
-- reset to 0 on success, on the forced handoff, and on agent re-arm. NULL is
-- never stored (NOT NULL DEFAULT 0). Present on BOTH channel conversation
-- tables so the shared loop behaves identically for WhatsApp and Instagram.
-- A constant DEFAULT makes this a metadata-only add (no table rewrite).

alter table public.whatsapp_conversations
  add column if not exists agent_verify_attempts smallint not null default 0;

alter table public.instagram_conversations
  add column if not exists agent_verify_attempts smallint not null default 0;

comment on column public.whatsapp_conversations.agent_verify_attempts is
  'AGENT-VERIFY-HANDOFF.1 — consecutive failed verify_identity attempts; reset on success/handoff/re-arm.';
comment on column public.instagram_conversations.agent_verify_attempts is
  'AGENT-VERIFY-HANDOFF.1 — consecutive failed verify_identity attempts; reset on success/handoff/re-arm.';
