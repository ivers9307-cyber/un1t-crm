-- ============================================================
-- 129: landing_page_settings — site logo for the public /welcome
-- top nav.
--
-- The top nav + footer are page chrome (they sit OUTSIDE the
-- operator-reorderable blocks array from mig 128) — they always
-- render. Today the nav shows a hard-coded "UN1T" wordmark in
-- bold-black tracking-widest. This migration adds three columns
-- so an operator can swap that wordmark for a custom logo image
-- without touching code.
--
-- Columns:
--   logo_url       — public URL of the logo image. NULL → fall
--                    back to the hard-coded "UN1T" text wordmark.
--   logo_alt       — alt text for screen readers / image-load
--                    failures. NULL → render alt="UN1T" so a11y
--                    is never empty.
--   logo_width_px  — max width of the rendered logo in pixels.
--                    Logos come in different aspect ratios; a
--                    square logo wants ~40px wide, a wordmark logo
--                    wants ~120-160. NULL → 96 (matches the
--                    visual weight of the existing UN1T wordmark).
--
-- Deliberately NOT a separate logo block. The logo lives in the
-- nav which always renders; making it a block would force the
-- operator to keep one (and only one) "logo" block in their
-- blocks array, which is more rope to hang themselves with. Same
-- reasoning as why the footer isn't a block.
--
-- Why three columns instead of one logo JSONB blob? Because
-- {url, alt, width} is small, fully typed in Postgres without
-- jsonb_build_object dances, and the form doesn't need to evolve
-- the shape. JSONB earns its keep when shape evolution matters
-- (the blocks array, the gallery items); a logo doesn't.
-- ============================================================

BEGIN;

ALTER TABLE public.landing_page_settings
  ADD COLUMN IF NOT EXISTS logo_url      TEXT,
  ADD COLUMN IF NOT EXISTS logo_alt      TEXT,
  ADD COLUMN IF NOT EXISTS logo_width_px INTEGER;

COMMENT ON COLUMN public.landing_page_settings.logo_url IS
  'Optional public URL for the top-nav logo image. NULL → render the hard-coded UN1T wordmark text. Mig 129.';

COMMENT ON COLUMN public.landing_page_settings.logo_width_px IS
  'Max width of the rendered logo in pixels. NULL → 96px default (matches the visual weight of the wordmark). Mig 129.';

-- Defensive sanity bound at the DB layer — operator could
-- otherwise set this to 0 or 99999 via a hand-crafted PUT and
-- break the layout. The Zod schema in the API route also caps
-- this; the DB check is the belt to the API's braces.
ALTER TABLE public.landing_page_settings
  DROP CONSTRAINT IF EXISTS landing_page_settings_logo_width_sane;
ALTER TABLE public.landing_page_settings
  ADD CONSTRAINT landing_page_settings_logo_width_sane
  CHECK (logo_width_px IS NULL OR (logo_width_px >= 24 AND logo_width_px <= 400));

COMMIT;
