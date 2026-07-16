-- 405 — WA-TECHPROV.1: Embedded Signup support on whatsapp_numbers.
--
-- Additive only. Existing rows (manually-entered System User tokens)
-- keep their meaning via the defaults. See
-- docs/WHATSAPP_TECH_PROVIDER_DESIGN_2026-07.md §4.3.

ALTER TABLE public.whatsapp_numbers
  ADD COLUMN IF NOT EXISTS token_type TEXT NOT NULL DEFAULT 'system_user'
    CHECK (token_type IN ('system_user', 'business')),
  ADD COLUMN IF NOT EXISTS connected_via TEXT NOT NULL DEFAULT 'manual'
    CHECK (connected_via IN ('manual', 'embedded_signup')),
  ADD COLUMN IF NOT EXISTS signup_meta JSONB;

COMMENT ON COLUMN public.whatsapp_numbers.token_type IS
  'system_user = manually-minted permanent token; business = Embedded Signup business token (WA-TECHPROV)';
COMMENT ON COLUMN public.whatsapp_numbers.connected_via IS
  'manual = operator-entered row; embedded_signup = created by the ES v4 flow (WA-TECHPROV)';
COMMENT ON COLUMN public.whatsapp_numbers.signup_meta IS
  'Raw ES session payload, probe snapshot, generated 2FA PIN (WA-TECHPROV)';
