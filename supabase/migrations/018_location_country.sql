-- ============================================================
-- 018: Country code on locations
--
-- ISO 3166-1 alpha-2 (e.g. 'IE', 'GB', 'US'). Used to look up the
-- right public-holiday list and any other country-specific behaviour
-- as more locations come online.
--
-- Existing rows backfill to 'IE' since the only seeded location is
-- UN1T Stillorgan.
-- ============================================================

ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS country CHAR(2) NOT NULL DEFAULT 'IE';

-- Sanity check: only allow uppercase A-Z. Forward-compatible — we don't
-- whitelist a fixed enum so adding new countries doesn't require a
-- migration, just a new entry in src/lib/bank-holidays.js.
ALTER TABLE locations
  ADD CONSTRAINT locations_country_format
  CHECK (country ~ '^[A-Z]{2}$');

COMMENT ON COLUMN locations.country IS
  'ISO 3166-1 alpha-2 country code. Drives country-specific behaviour '
  'such as public holiday lists in src/lib/bank-holidays.js.';
