-- WA-MULTI.1 — per-location WhatsApp Cloud API configuration table.
--
-- Today every WA send goes through global env vars
-- (WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID /
-- WHATSAPP_BUSINESS_ACCOUNT_ID / WHATSAPP_APP_ID). One number,
-- one set of credentials, hard-coded into Vercel. Adding a second
-- number — e.g. a coexistence-mode mobile WA Business number that
-- the operator wants to keep using from their phone while
-- automation also reaches it via the Cloud API — required a
-- second app deployment. This table moves the credential per-row
-- so adding a number is a `whatsapp_numbers` insert + a UI flip.
--
-- Each row represents one phone number registered against the
-- Meta WhatsApp Business Platform. A location may have multiple
-- rows (e.g. one Cloud API number + one Coexistence mobile
-- number) but only one is `is_default` at a time — outbound sends
-- with no explicit number-id route through the default.
--
-- Backwards compatibility: when a location has zero rows here,
-- the lib falls back to the global env vars (existing behaviour).
-- Operators can migrate one location at a time without taking
-- the platform down.

CREATE TABLE IF NOT EXISTS public.whatsapp_numbers (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id         UUID NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  label               TEXT NOT NULL,
  -- Meta's identifiers — phone_number_id is globally unique on
  -- their side (one phone = one PHONE_NUMBER_ID across the entire
  -- WhatsApp Business Platform), so we unique-index it across the
  -- whole table, not just per-location.
  phone_number_id     TEXT NOT NULL,
  business_account_id TEXT,
  app_id              TEXT,
  -- Permanent system-user token issued via the Meta Business
  -- Manager. Stored as plaintext to match the existing
  -- xero_connections.access_token pattern — encryption-at-rest is
  -- a separate concern handled across all integrations.
  access_token        TEXT NOT NULL,
  display_phone       TEXT,
  source              TEXT NOT NULL DEFAULT 'cloud_api'
                      CHECK (source IN ('cloud_api', 'coexistence')),
  is_default          BOOLEAN NOT NULL DEFAULT false,
  is_active           BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (phone_number_id),
  UNIQUE (location_id, label)
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_numbers_location
  ON public.whatsapp_numbers (location_id);

-- Exactly one default per location. Partial-unique on (location_id)
-- WHERE is_default = true. Inserting a new default + flipping the
-- old one to false has to happen in the same transaction (the
-- write path in the API route handles this).
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_numbers_default
  ON public.whatsapp_numbers (location_id) WHERE is_default = true;

ALTER TABLE public.whatsapp_numbers ENABLE ROW LEVEL SECURITY;

-- Read: master + in-location.
DROP POLICY IF EXISTS whatsapp_numbers_select ON public.whatsapp_numbers;
CREATE POLICY whatsapp_numbers_select
  ON public.whatsapp_numbers
  FOR SELECT
  USING (
    private.auth_is_master()
    OR private.auth_is_in_location(location_id)
  );

-- Write: service-role only. The API routes use the service-role
-- client + check master/owner permission at the route layer.
-- Belt-and-braces RESTRICTIVE deny for authenticated + anon.
DROP POLICY IF EXISTS whatsapp_numbers_deny_writes ON public.whatsapp_numbers;
CREATE POLICY whatsapp_numbers_deny_writes
  ON public.whatsapp_numbers
  AS RESTRICTIVE
  FOR ALL
  TO authenticated, anon
  USING (false)
  WITH CHECK (false);

COMMENT ON TABLE public.whatsapp_numbers IS
  'WA-MULTI.1 — per-location WhatsApp Cloud API configuration. Each row is one phone number registered against the Meta WhatsApp Business Platform. Locations with zero rows here fall back to the global WHATSAPP_* env vars (transitional backwards-compat). Default-per-location enforced via partial unique index.';

-- Inbound webhook routing reverse-index: when Meta posts a message
-- to our webhook, the payload carries the recipient phone_number_id
-- but no location_id. The webhook handler looks up the row via
-- this PK / phone_number_id constraint to route the message to the
-- right location's inbox. The UNIQUE (phone_number_id) constraint
-- above already covers the lookup; this comment documents the
-- intent for future readers.
