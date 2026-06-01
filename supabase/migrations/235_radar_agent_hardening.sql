-- RADAR-AGENT hardening (P1/P2).
--
-- 1. agent_processing_at — a per-conversation concurrency claim so two
--    near-simultaneous inbound messages can't both spin up an agent turn
--    on the same thread (double-reply / double-spend / verify race). The
--    runner sets it before working and clears it after; a stale claim
--    (>90s, e.g. a crashed lambda) is reclaimable.
-- 2. instagram_conversations.customer_name — the customer's IG display
--    name, fetched best-effort from the Graph API on first contact. Used
--    as a surname hint so a member who verifies by email on Instagram
--    doesn't have to retype a surname their IG name already shows.

ALTER TABLE public.whatsapp_conversations
  ADD COLUMN IF NOT EXISTS agent_processing_at timestamptz;

ALTER TABLE public.instagram_conversations
  ADD COLUMN IF NOT EXISTS agent_processing_at timestamptz;

ALTER TABLE public.instagram_conversations
  ADD COLUMN IF NOT EXISTS customer_name text;

COMMENT ON COLUMN public.whatsapp_conversations.agent_processing_at IS
  'RADAR-AGENT concurrency claim: set while an agent turn is in flight, cleared after. Stale (>90s) claims are reclaimable.';
COMMENT ON COLUMN public.instagram_conversations.agent_processing_at IS
  'RADAR-AGENT concurrency claim: set while an agent turn is in flight, cleared after. Stale (>90s) claims are reclaimable.';
COMMENT ON COLUMN public.instagram_conversations.customer_name IS
  'Customer IG display name (Graph API), used as a surname hint for email-path identity verification.';
