-- 338 — whatsapp_broadcasts.handle_replies_manually
--
-- AGENT-TAKEOVER (broadcast scope). A WhatsApp send the operator is personally
-- managing must not have Mia auto-reply to the recipients' responses. That's
-- automatic for an INDIVIDUAL send (audience of 1 — a targeted 1:1 message that
-- happens to use the broadcast machinery). For a BULK send the operator opts in
-- via this flag ("I'll handle replies myself"): when true, the send loop stamps
-- each recipient's conversation as a human take-over (agent_active=false), so
-- Mia stays out (auto re-arms after the handoff cooldown, same as a manual send).

alter table public.whatsapp_broadcasts
  add column if not exists handle_replies_manually boolean not null default false;

comment on column public.whatsapp_broadcasts.handle_replies_manually is
  'AGENT-TAKEOVER (mig 338) — when true, the WhatsApp send pauses Mia on each recipient thread (operator handles the replies). A single-recipient send pauses automatically regardless of this flag.';
