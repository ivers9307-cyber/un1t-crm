-- 322_contacts_body_metrics.sql
-- Body metrics needed to compute calories for in-studio HR sessions, captured at
-- profile setup and kept fresh from the freshest source.
--
-- NOTE: contacts.dob (mig 134) and contacts.gender already exist from the Glofox
-- sync. gender holds 'female' | 'male' | null AND a legacy 'P' code (≈ "prefer not
-- to say", ~1.5k rows) — so we deliberately add NO CHECK constraint here. New
-- self-service writes are validated to female|male|other at the app layer
-- (/api/me/body-metrics zod schema); the calorie calc treats anything that isn't
-- 'male'/'female' (incl. 'P', 'other', null) as sex-neutral. Only the four new
-- columns below are introduced.
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS weight_kg numeric,
  ADD COLUMN IF NOT EXISTS weight_kg_source text,
  ADD COLUMN IF NOT EXISTS weight_kg_at timestamptz,
  ADD COLUMN IF NOT EXISTS profile_setup_completed_at timestamptz;

COMMENT ON COLUMN public.contacts.weight_kg IS 'Current body weight (kg) — freshest of manual/inbody/apple_health (mig 322).';
COMMENT ON COLUMN public.contacts.weight_kg_source IS 'manual | inbody | apple_health (mig 322).';
COMMENT ON COLUMN public.contacts.profile_setup_completed_at IS 'Set once dob+gender+weight_kg all present via /api/me/body-metrics (mig 322).';
