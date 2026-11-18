-- 851_schema_catch_up.sql (SCHEMACATCHUP.1)
--
-- Two tables and nine columns (seven of them in 852) exist on the live database
-- with no migration file creating them: they were applied by hand (the live migration history
-- shows 460_account_claim_tokens, add_agent_activity_notified_at,
-- whatsapp_coexistence_181 and whatsapp_numbers_embedded_signup, none of which
-- is in this folder). check:schema-snapshot found them. This file records them
-- with their live definitions, read from the catalog on 18 Nov 2026, so a
-- database built from this folder has them too.
--
-- On the live database every CREATE and ADD below is a no-op (IF NOT EXISTS).
-- The one real change there is the REVOKE: authenticated still holds table
-- privileges on the two claim tables from the old defaults. RLS is on with no
-- policy, so those privileges already admit nothing, and both tables are empty
-- and read by no code.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- ─── Mobile app claim links ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.app_claim_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id  uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES public.locations(id),
  token_hash  text,
  channel     text NOT NULL CHECK (channel = ANY (ARRAY['whatsapp'::text, 'email'::text, 'qr'::text])),
  wave        integer,
  queued_at   timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz,
  wa_message_id text,
  clicked_at  timestamptz,
  claimed_at  timestamptz,
  expires_at  timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN public.app_claim_tokens.token_hash IS
  'sha-256 hex of the raw token. NULL while queued for the drain cron (mig 460).';

CREATE UNIQUE INDEX IF NOT EXISTS app_claim_tokens_hash_key
  ON public.app_claim_tokens (token_hash) WHERE token_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS app_claim_tokens_live_per_contact
  ON public.app_claim_tokens (contact_id) WHERE claimed_at IS NULL AND revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS app_claim_tokens_wave_idx
  ON public.app_claim_tokens (location_id, wave);
CREATE INDEX IF NOT EXISTS app_claim_tokens_wa_message_idx
  ON public.app_claim_tokens (wa_message_id) WHERE wa_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS app_claim_tokens_pending_idx
  ON public.app_claim_tokens (queued_at) WHERE sent_at IS NULL AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS public.claim_link_requests (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id        uuid REFERENCES public.locations(id),
  phone_normalized   text NOT NULL,
  outcome            text NOT NULL CHECK (outcome = ANY (ARRAY['sent'::text, 'no_match'::text, 'duplicate'::text, 'already_linked'::text, 'send_failed'::text])),
  matched_contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  resolved_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS claim_link_requests_outcome_idx
  ON public.claim_link_requests (outcome, created_at DESC);

ALTER TABLE public.app_claim_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claim_link_requests ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.app_claim_tokens FROM anon, authenticated;
REVOKE ALL ON public.claim_link_requests FROM anon, authenticated;

-- ─── Agent activity notice ───────────────────────────────────────────────

ALTER TABLE public.whatsapp_conversations
  ADD COLUMN IF NOT EXISTS agent_activity_notified_at timestamptz;
ALTER TABLE public.instagram_conversations
  ADD COLUMN IF NOT EXISTS agent_activity_notified_at timestamptz;

COMMIT;
