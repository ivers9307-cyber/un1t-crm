-- 728_org_settings_customer_agent.sql
-- MIAORG.1 — Mia's settings at ORGANISATION level. One blob per organisation,
-- the same shape as locations.settings.customer_agent (src/lib/agent/
-- settings-contract.js), resolved under each studio's own blob by
-- resolveAgentSettings (src/lib/agent/settings-resolve.js):
--   DEFAULTS <- org_settings.customer_agent <- locations.settings.customer_agent
-- The studio-only keys (enabled, test_mode, test_phones, booking_mode, ...) are
-- never inherited from here, so a value in this column can never switch Mia on
-- at a studio.
-- NULL = the organisation sets nothing, so every studio resolves exactly as it
-- did before this column existed. No default, no backfill.
-- DECISION (recorded here): org_settings_select (mig 317/320) lets every member
-- of the organisation read this table, so this column holds COPY AND TUNING
-- ONLY (tone, rules, customer texts, limits, follow-up timings). It must never
-- hold a secret or a credential.
-- column-grant: org_settings carries table-level SELECT for authenticated, so
-- no column grant is needed; no privilege changes.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE public.org_settings ADD COLUMN IF NOT EXISTS customer_agent jsonb;
COMMENT ON COLUMN public.org_settings.customer_agent IS
  'MIAORG.1 (mig 728): organisation-level Mia defaults, same shape as locations.settings.customer_agent; studio-only keys are never read from here. NULL = none set. Readable by every org member through org_settings_select, so copy and tuning only, no secrets.';
COMMIT;
