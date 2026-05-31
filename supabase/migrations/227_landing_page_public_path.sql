-- 227: per-studio landing pages (un1tdublin.com two-location split)
--
-- public_path decouples the public marketing URL (/stillorgan,
-- /hatch-street) from internal location slugs so a location rename
-- can't break shared marketing links. chooser_image_url is an
-- optional per-studio cover for the split chooser tiles (falls back
-- to the studio hero image when null).
ALTER TABLE landing_page_settings
  ADD COLUMN IF NOT EXISTS public_path text;

ALTER TABLE landing_page_settings
  ADD COLUMN IF NOT EXISTS chooser_image_url text;

CREATE UNIQUE INDEX IF NOT EXISTS landing_page_settings_public_path_key
  ON landing_page_settings (public_path)
  WHERE public_path IS NOT NULL;

-- Stillorgan = the only pre-existing landing row.
UPDATE landing_page_settings
  SET public_path = 'stillorgan'
  WHERE location_id = 'a0000000-0000-0000-0000-000000000001';
