-- 247_landing_page_publish_state.sql
-- Operator-controlled publish state for public studio marketing pages.
-- Replaces the hardcoded DISABLED_TILE_PATHS set in src/app/welcome/page.js
-- (the Hatch Street unlock, UNLOCK-HATCH.1) with a single DB column the
-- Settings → Landing Page editor owns.

ALTER TABLE public.landing_page_settings
  ADD COLUMN IF NOT EXISTS publish_state text NOT NULL DEFAULT 'hidden'
    CHECK (publish_state IN ('live', 'coming_soon', 'hidden'));

-- Backfill the two existing studios to their current real-world state
-- (both are live as of the Hatch Street unlock). New rows default to
-- 'hidden' so a freshly-created studio page is never accidentally public.
UPDATE public.landing_page_settings
  SET publish_state = 'live'
  WHERE public_path IN ('stillorgan', 'hatch-street');

COMMENT ON COLUMN public.landing_page_settings.publish_state IS
  'Public visibility: live = active clickable tile + page renders; coming_soon = dimmed non-clickable teaser tile + page 404s; hidden = no tile + page 404s. Operator-set via /settings/landing-page. Replaces DISABLED_TILE_PATHS.';
