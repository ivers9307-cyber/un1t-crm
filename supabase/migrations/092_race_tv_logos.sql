-- ============================================================
-- 092: race_events.tv_logos — sponsor / branding logos for the
-- TV display board.
--
-- Up to 3 image URLs rendered centred in the header of the public
-- /race/[slug]/display board. Stored as a JSONB array of strings;
-- each entry is the public URL of an object in the existing
-- 'branding' Supabase Storage bucket (uploaded by the operator
-- via /api/races/[id]/logo). The page enforces the max of 3 in
-- the UI; the schema allows up to 6 to leave headroom for future
-- multi-screen layouts.
--
-- Why JSONB vs three nullable text columns: the operator may want
-- to add, remove, and reorder logos over time. A JSONB array
-- makes that a single update; with named columns the same
-- operation needs awkward NULL-shuffling.
-- ============================================================

BEGIN;

ALTER TABLE race_events
  ADD COLUMN IF NOT EXISTS tv_logos JSONB DEFAULT '[]'::jsonb;

-- Defensive cap so a buggy client can't write a 1000-entry array.
-- 6 leaves headroom for v2 layouts; the form caps at 3.
ALTER TABLE race_events
  ADD CONSTRAINT race_events_tv_logos_size_check
  CHECK (jsonb_typeof(tv_logos) = 'array' AND jsonb_array_length(tv_logos) <= 6);

COMMENT ON COLUMN race_events.tv_logos IS
  'Mig 092: array of public URLs (strings) for sponsor/branding logos rendered on /race/[slug]/display. Max 6 enforced by CHECK; UI limits to 3. Files live in the branding Supabase Storage bucket under race-logos/<race_id>/.';

COMMIT;
