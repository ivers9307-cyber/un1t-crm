-- INBOX-REDESIGN 2026-07 — WhatsApp "pause Mia" toggle.
-- Dedicated, sticky, nullable timestamp. Deliberately NOT a reuse of
-- agent_active: that flag auto-rearms after handoff_cooldown_hours and is
-- flipped by every staff WA reply (manualTakeoverPatch), so it can't express
-- an explicit "stay off until I resume". null = Mia active; set = Mia paused.
alter table public.whatsapp_conversations
  add column if not exists agent_paused_at timestamptz;

comment on column public.whatsapp_conversations.agent_paused_at is
  'When set, Mia will not auto-reply to this WhatsApp conversation (sticky; cleared only by the resume endpoint). Nullable, no default — metadata-only add. (INBOX-REDESIGN mig 435)';
