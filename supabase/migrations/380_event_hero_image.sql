-- 380: Per-event hero image + accent colour for the public event page.
--
-- Additive and nullable — events with no image fall back to the
-- generated accent→black poster hero shipped in EVENTS-RESKIN.1, so no
-- backfill is required and existing events render unchanged.
--
-- hero_image_url points at the existing 'branding' Storage bucket at
-- race-hero/<race_id>/hero.<ext> (same bucket as the TV sponsor logos,
-- mig 092). accent_hex is an optional brand accent for the page.

BEGIN;

ALTER TABLE race_events
  ADD COLUMN IF NOT EXISTS hero_image_url TEXT,
  ADD COLUMN IF NOT EXISTS accent_hex     TEXT;

COMMENT ON COLUMN race_events.hero_image_url IS
  'Public URL of the operator-uploaded hero image for the public event landing page (branding bucket, race-hero/<race_id>/). NULL = fall back to the generated accent→black poster hero (EVENTS-RESKIN.1).';

COMMENT ON COLUMN race_events.accent_hex IS
  'Optional hex accent colour (e.g. #22C55E) for the public event page — tints the poster gradient / status pill. NULL = default white / HR-zone treatment.';

COMMIT;
