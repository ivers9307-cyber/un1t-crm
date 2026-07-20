-- SAAS4-C2 — per-tenant legal identity for the templated privacy
-- notice (SaaS machinery plan §6). Each tenant gym is the CONTROLLER
-- of its members' data; the notice served on its hostname must name
-- THEIR entity. All four fields nullable: until entity name AND
-- privacy contact email are both set, the tenant's hostname renders
-- the platform copy (never a half-filled legal page —
-- src/lib/tenant-privacy.js shapeTenantPrivacyEntity).

ALTER TABLE org_settings
  ADD COLUMN legal_entity_name TEXT,
  ADD COLUMN legal_trading_name TEXT,
  ADD COLUMN legal_address TEXT,
  ADD COLUMN privacy_contact_email TEXT;

COMMENT ON COLUMN org_settings.legal_entity_name IS
  'SAAS4-C2: the tenant''s registered company name (data controller on their privacy notice). With privacy_contact_email, the minimum for the tenant-hosted notice to render.';
COMMENT ON COLUMN org_settings.privacy_contact_email IS
  'SAAS4-C2: the tenant''s privacy contact. Required (with legal_entity_name) before their hostname serves a tenant-entity notice.';
