-- ============================================================
-- 127: landing_page_settings — Phase 3a media additions.
--
-- Extends mig 126 with the four media types the operator asked for:
--
--   1. hero_video_url     — autoplay-muted-loop background video
--                           that swaps in for the hero image (or
--                           the gradient if no image either) when
--                           set. Stored in the same 'branding' bucket
--                           at landing-page/<loc>/hero-video.<ext>.
--
--   2. gallery_title +    — new optional photo gallery section
--      gallery JSONB         rendered between the pillars and the
--                           proof block. Operator uploads N photos
--                           (one at a time via the gallery-photo
--                           upload route). Shape per item:
--                             { url, alt?, caption? }
--                           Empty array → section not rendered.
--
--   3. embed_title +      — new optional embedded video section.
--      embed_url +           Operator pastes a YouTube or Instagram
--      embed_caption         URL; render layer parses provider +
--                           video/post id and emits the right
--                           <iframe>. embed_type is derived at
--                           render time, not stored — keeps schema
--                           dumb and avoids drift if URL changes.
--
--   4. pillars[i].photo_url — optional photo above each "What we
--                             do" pillar. JSONB shape change only
--                             (no new column needed) — the existing
--                             pillars column already accepts
--                             arbitrary keys, the API schema gets
--                             photo_url added to PillarSchema.
--
-- All NULL/empty → page falls back to the Phase 2 layout (hero
-- image OR gradient, no gallery, no embed, plain pillars). The
-- public surface never breaks on a partially-edited row.
-- ============================================================

BEGIN;

ALTER TABLE public.landing_page_settings
  ADD COLUMN IF NOT EXISTS hero_video_url TEXT,
  ADD COLUMN IF NOT EXISTS gallery_title  TEXT,
  ADD COLUMN IF NOT EXISTS gallery        JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS embed_title    TEXT,
  ADD COLUMN IF NOT EXISTS embed_url      TEXT,
  ADD COLUMN IF NOT EXISTS embed_caption  TEXT;

COMMENT ON COLUMN public.landing_page_settings.hero_video_url IS
  'Optional MP4/WebM URL. When set, takes precedence over hero_image_url and renders as autoplay/muted/loop background video in the hero. The image still serves as poster while the video loads. Mig 127.';

COMMENT ON COLUMN public.landing_page_settings.gallery IS
  'Optional photo gallery rendered between pillars and proof. Shape: [{ url, alt?, caption? }]. Empty array hides the section. Mig 127.';

COMMENT ON COLUMN public.landing_page_settings.embed_url IS
  'Optional YouTube or Instagram URL. Render layer parses provider + id and emits the matching iframe. Empty hides the embed section. Mig 127.';

COMMIT;
