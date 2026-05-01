-- Per-location feature gates. Each location's owner can toggle
-- individual features off for everyone at that location, regardless
-- of user-level permissions or role defaults.
--
-- Resolution semantics:
--   location.features[key] === false  → DENIED at location-level
--                                        (user-level setting ignored)
--   missing key OR === true           → ENABLED at location-level
--                                        (user-level check proceeds)
--
-- Default {} (empty) means "every feature enabled" — preserves
-- existing behaviour for all rows, owners opt OUT of features
-- they don't want at a given studio.

ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS features JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN locations.features IS
  'Per-location feature gate. Maps feature_key → boolean. Missing key means enabled. Explicit false denies access for every user at this location regardless of role or per-user permission. Editable by owners only.';
