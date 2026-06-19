-- 295: CHAMP-NATIVE.1 P3 — Expo push tokens for the champ-app CUSTOMER native
-- app, keyed by contact_id (mirrors staff device_tokens, mig 023). Written by
-- champ-app /api/mobile/push-token via the service client; read by un1t-crm
-- sendCustomerPush(). Service-role only — RLS denies anon/authenticated.
CREATE TABLE IF NOT EXISTS public.champ_push_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  expo_push_token text NOT NULL UNIQUE,
  platform text NOT NULL CHECK (platform IN ('ios','android','web')),
  device_name text,
  app_version text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_champ_push_tokens_contact ON public.champ_push_tokens(contact_id);

ALTER TABLE public.champ_push_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY "champ_push_tokens deny anon" ON public.champ_push_tokens
  AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);
CREATE POLICY "champ_push_tokens deny authenticated" ON public.champ_push_tokens
  AS RESTRICTIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);

COMMENT ON TABLE public.champ_push_tokens IS 'CHAMP-NATIVE.1 P3: Expo push tokens for the champ-app customer native app, keyed by contact_id. Service-role only.';
