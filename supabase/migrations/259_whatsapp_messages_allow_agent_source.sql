-- AGENT-FIX.1 — allow source='agent' on whatsapp_messages.
--
-- The 2026-06-12 amnesia incident: the customer agent records every
-- reply it sends with source='agent' (AGENT_MESSAGE_SOURCE — load-
-- bearing: countAgentReplies() builds the cost caps on it, and the
-- agent rebuilds its conversation view from this table every turn).
-- But the source CHECK constraint (added with the coexistence work)
-- only allowed 'api' / 'app_echo' / 'history_sync', so EVERY agent
-- reply insert was rejected — silently, because supabase-js returns
-- { error } without throwing and the result was discarded.
--
-- Net effect: sends succeeded (customer got the message) but the agent
-- never saw its own replies in history → it repeated questions, asked
-- for verification again mid-flow, and restarted conversations. The
-- cost caps also counted 0 forever. instagram_messages has no source
-- constraint, so IG was unaffected.
--
-- 'operator' is included too: instagram_messages uses it for manual
-- inbox sends and the WhatsApp side should be free to adopt the same
-- convention without a migration.

ALTER TABLE public.whatsapp_messages
  DROP CONSTRAINT IF EXISTS whatsapp_messages_source_check;

ALTER TABLE public.whatsapp_messages
  ADD CONSTRAINT whatsapp_messages_source_check
  CHECK (source = ANY (ARRAY['api'::text, 'app_echo'::text, 'history_sync'::text, 'agent'::text, 'operator'::text]));
