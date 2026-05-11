-- ============================================================
-- 128: landing_page_settings — blocks JSONB array (Phase 3b).
--
-- Phase 3a shipped a flat-column row (hero_*, pillars, stats,
-- gallery, embed_*, testimonial_*) with a fixed render order baked
-- into welcome/page.js. Phase 3b lifts the section sequence into
-- the database so operators can reorder / add / remove sections
-- via drag-and-drop in the settings UI.
--
-- New shape:
--   blocks JSONB — array of typed block objects rendered in order.
--   Each block: { id: uuid_string, type: enum, ...content_fields }
--
-- Block types supported in 3b:
--   hero        — eyebrow, headline, subhead, subtext, image_url, video_url
--   booking     — slug
--   pillars     — items: [{ number, title, body, photo_url }]
--   gallery     — title, items: [{ url, alt, caption }]
--   embed       — title, url, caption
--   stats       — items: [{ number, label }]
--   testimonial — quote, author
--
-- Top nav + footer are NOT blocks — they always render and aren't
-- operator-reorderable. (Operators don't need to move the footer
-- and the cost of letting them is a footer that disappears one
-- afternoon.)
--
-- Migration strategy — additive, dual-render, safe rollback:
--   1. Add blocks JSONB column (nullable, no default).
--   2. UPDATE existing row to populate blocks from the current
--      flat columns. Order matches the fixed render order today:
--      hero → booking → pillars → gallery → embed → stats → testimonial.
--      Empty/null gallery + embed are skipped (today's render also
--      hides those when empty).
--   3. Welcome page render: if blocks IS NOT NULL and length > 0,
--      use blocks; else fall back to the flat-column render.
--   4. Operator form switches to writing the blocks column ONLY.
--      Flat columns stay frozen for safety / rollback. A future
--      migration (130 or later) can drop the flat columns once we
--      trust the new path.
--
-- Idempotent — guarded by ADD COLUMN IF NOT EXISTS so re-running
-- this migration is a no-op even after rows have been edited.
-- ============================================================

BEGIN;

ALTER TABLE public.landing_page_settings
  ADD COLUMN IF NOT EXISTS blocks JSONB;

COMMENT ON COLUMN public.landing_page_settings.blocks IS
  'Ordered array of section blocks rendered between the top nav and the footer. Each block: { id, type, ...content }. NULL or empty = fall back to the flat-column render. Mig 128 (Phase 3b).';

-- One-time backfill — only writes to rows where blocks is still
-- NULL (i.e. never been edited under the new path). The
-- jsonb_strip_nulls keeps the resulting blob compact when a
-- column is unset.
UPDATE public.landing_page_settings
SET blocks = (
  SELECT jsonb_agg(b ORDER BY ord)
  FROM (
    SELECT 1 AS ord, jsonb_strip_nulls(jsonb_build_object(
      'id',         gen_random_uuid()::text,
      'type',       'hero',
      'eyebrow',    NULLIF(hero_eyebrow, ''),
      'headline',   NULLIF(hero_headline, ''),
      'subhead',    NULLIF(hero_subhead, ''),
      'subtext',    NULLIF(hero_subtext, ''),
      'image_url',  NULLIF(hero_image_url, ''),
      'video_url',  NULLIF(hero_video_url, '')
    )) AS b
    UNION ALL
    SELECT 2, jsonb_strip_nulls(jsonb_build_object(
      'id',   gen_random_uuid()::text,
      'type', 'booking',
      'slug', NULLIF(booking_slug, '')
    ))
    UNION ALL
    SELECT 3, jsonb_build_object(
      'id',    gen_random_uuid()::text,
      'type',  'pillars',
      'items', COALESCE(pillars, '[]'::jsonb)
    )
    UNION ALL
    SELECT 4, jsonb_build_object(
      'id',    gen_random_uuid()::text,
      'type',  'gallery',
      'title', NULLIF(gallery_title, ''),
      'items', COALESCE(gallery, '[]'::jsonb)
    )
    WHERE COALESCE(jsonb_array_length(gallery), 0) > 0
    UNION ALL
    SELECT 5, jsonb_strip_nulls(jsonb_build_object(
      'id',      gen_random_uuid()::text,
      'type',    'embed',
      'title',   NULLIF(embed_title, ''),
      'url',     NULLIF(embed_url, ''),
      'caption', NULLIF(embed_caption, '')
    ))
    WHERE NULLIF(embed_url, '') IS NOT NULL
    UNION ALL
    SELECT 6, jsonb_build_object(
      'id',    gen_random_uuid()::text,
      'type',  'stats',
      'items', COALESCE(stats, '[]'::jsonb)
    )
    UNION ALL
    SELECT 7, jsonb_strip_nulls(jsonb_build_object(
      'id',     gen_random_uuid()::text,
      'type',   'testimonial',
      'quote',  NULLIF(testimonial_quote, ''),
      'author', NULLIF(testimonial_author, '')
    ))
    WHERE NULLIF(testimonial_quote, '') IS NOT NULL
       OR NULLIF(testimonial_author, '') IS NOT NULL
  ) sub
)
WHERE blocks IS NULL;

COMMIT;
