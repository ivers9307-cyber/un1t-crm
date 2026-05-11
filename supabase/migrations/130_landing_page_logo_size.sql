-- ============================================================
-- 130: landing_page_settings — widen the logo_width_px range
-- so operators can set noticeably larger logos.
--
-- Mig 129 capped width at 24-400px. In practice operators were
-- finding the rendered logo too small even at the 96px default,
-- because the welcome page render also pinned height to h-10
-- (40px) which made the width cap mostly inoperative for
-- most aspect ratios. The render now uses width-driven sizing
-- (height auto-follows aspect), and 400px isn't enough headroom
-- for a wordmark logo someone wants prominent.
--
-- New range 40-600. Lower bound bumped from 24 → 40 because
-- anything under ~40px is basically a favicon — if you want
-- something that small, leave the logo blank and use the
-- wordmark text fallback.
-- ============================================================

BEGIN;

ALTER TABLE public.landing_page_settings
  DROP CONSTRAINT IF EXISTS landing_page_settings_logo_width_sane;
ALTER TABLE public.landing_page_settings
  ADD CONSTRAINT landing_page_settings_logo_width_sane
  CHECK (logo_width_px IS NULL OR (logo_width_px >= 40 AND logo_width_px <= 600));

COMMIT;
