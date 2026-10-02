-- 696 — WAREPLYNUMBER.1 (C86): record which WhatsApp number a customer wrote
-- to, so replies go from it. Adds whatsapp_conversations.whatsapp_number_id
-- (nullable FK to whatsapp_numbers) and a partial index. No backfill; nothing
-- else changes.
--
-- NOT APPLIED YET when this file was written. "VERIFIED LIVE" below is prod
-- BEFORE this file runs (read-only, Supabase MCP, 2 Oct 2026; counts only).
-- Behaviour is proven ahead of apply by
-- tests/migration-696-whatsapp-conversations-reply-number.test.js.
--
-- ===========================================================================
-- THE FINDING (follow-ups C86, found building WANITS.1 / planning C81)
-- ===========================================================================
-- Nothing records which number a customer wrote to. Every reply into a
-- thread (staff send, Flow, carousel, reaction, Mia, her confirmations) goes
-- from the studio's DEFAULT number (getWhatsAppConfig). At a studio with two
-- numbers, a customer who wrote to the second gets the answer from the first:
-- a different chat on their phone, and a reaction Meta refuses (it must come
-- from the number that holds the message). Latent: no studio has two numbers.
--
-- VERIFIED LIVE (2 Oct, BEFORE this migration):
--   * whatsapp_numbers: 1 row, 1 active; at most 1 active per location.
--   * whatsapp_conversations: 1,400 rows (1.2 MB), no whatsapp_number_id
--     column; relacl {postgres=arwdDxtm, authenticated=r, service_role=
--     arwdDxtm} (mig 661/673: read-only for authenticated, nothing for anon);
--     one policy wa_conv_select (SELECT); trigger set_wa_conversations_updated_at.
--   * whatsapp_numbers.id is uuid.
--
-- ===========================================================================
-- THE FIX
-- ===========================================================================
--   whatsapp_number_id uuid NULL REFERENCES whatsapp_numbers(id) ON DELETE
--   SET NULL. The webhook stamps it with the receiving number (when that
--   number belongs to the thread's studio); getConversationReplyConfig
--   (src/lib/whatsapp-config.js) replies from it while it is an active row at
--   that studio, else from the default. NULL = the default, i.e. exactly
--   today's behaviour, so no backfill: with one number in the estate the
--   default IS the number every thread was written to. Deleting a number
--   clears the stamp (replies fall back to the default).
--   The ACL is unchanged: authenticated keeps its table-level SELECT, so the
--   phone and the inbox realtime can read the column (a uuid, no secret);
--   no client gains a write.
--
-- APPLY: after the PR merges, apply 696 then 697. Until 696 is applied the
-- webhook's stamp fails (logged, costs nothing else) and every reply goes
-- from the default number, as today. Pre/post probes and the rollback (DROP
-- COLUMN) are in the PR body.
-- ===========================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF to_regclass('public.whatsapp_conversations') IS NULL OR to_regclass('public.whatsapp_numbers') IS NULL THEN
    RAISE EXCEPTION 'mig 696: whatsapp_conversations and whatsapp_numbers must exist';
  END IF;
END $$;

ALTER TABLE public.whatsapp_conversations
  ADD COLUMN IF NOT EXISTS whatsapp_number_id uuid
    REFERENCES public.whatsapp_numbers(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.whatsapp_conversations.whatsapp_number_id IS
  'WAREPLYNUMBER.1 (mig 696): the whatsapp_numbers row the customer last wrote to, stamped by the inbound webhook. Replies go from it while it is active at this location; NULL = the location default.';

CREATE INDEX IF NOT EXISTS idx_wa_conversations_number
  ON public.whatsapp_conversations (whatsapp_number_id)
  WHERE whatsapp_number_id IS NOT NULL;

-- Self-check: the catalog, never this file's text.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_attribute a
     WHERE a.attrelid = 'public.whatsapp_conversations'::regclass
       AND a.attname = 'whatsapp_number_id'
       AND NOT a.attisdropped
       AND a.atttypid = 'uuid'::regtype
       AND NOT a.attnotnull
  ) THEN
    RAISE EXCEPTION 'mig 696: whatsapp_conversations.whatsapp_number_id is not a nullable uuid column';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint c
     WHERE c.conrelid = 'public.whatsapp_conversations'::regclass
       AND c.contype = 'f'
       AND c.confrelid = 'public.whatsapp_numbers'::regclass
       AND c.confdeltype = 'n'
       AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute
                              WHERE attrelid = 'public.whatsapp_conversations'::regclass
                                AND attname = 'whatsapp_number_id')]::smallint[]
  ) THEN
    RAISE EXCEPTION 'mig 696: whatsapp_conversations.whatsapp_number_id has no ON DELETE SET NULL foreign key to whatsapp_numbers';
  END IF;
  IF has_table_privilege('anon', 'public.whatsapp_conversations', 'SELECT, INSERT, UPDATE, DELETE')
     OR has_table_privilege('authenticated', 'public.whatsapp_conversations', 'INSERT, UPDATE, DELETE') THEN
    RAISE EXCEPTION 'mig 696: a client role holds a write (or anon any privilege) on whatsapp_conversations';
  END IF;
  RAISE NOTICE 'mig 696: whatsapp_conversations.whatsapp_number_id ready (% stamped).',
    (SELECT count(*) FROM public.whatsapp_conversations WHERE whatsapp_number_id IS NOT NULL);
END $$;

COMMIT;
