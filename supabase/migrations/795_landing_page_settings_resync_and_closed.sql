-- 795_landing_page_settings_resync_and_closed.sql  (PAGES.1, PR3 / Task 26)
--
-- Mig 792 turned the studio pages into records (landing_pages +
-- landing_page_studios) and left landing_page_settings in place, deprecated,
-- while PR1-PR3 moved every reader off it. Nothing reads it any more
-- (tests/landing-page-settings-readers-guard.test.js). This migration closes
-- the gap between the two and shuts the old table:
--   * section 2: one last re-sync of any studio page the LEGACY editor changed
--     after mig 792 copied it (s.updated_at > p.updated_at), so an edit made
--     between 792 and the PR3 deploy is not lost;
--   * section 3: a legacy row with no studio page gets one, exactly as 792
--     section 6 did;
--   * section 4: every all-studios page (the /trial page) gets a landing_page_studios
--     row, switched OFF, for each active studio of its organisation that has none,
--     so the editor lists the studio and staff switch it on;
--   * section 5: the old table is closed to every client role (REVOKE ALL, its
--     four policies dropped, RLS stays on) and dated for drop.
-- Design: docs/superpowers/specs/2026-10-30-landing-pages-editor-design.md
-- (sections 1, 6).
--
-- Idempotent: the re-sync UPDATEs are conditional on updated_at (and the page
-- UPDATE's own trigger, update_updated_at, stamps now(), so a second run finds
-- nothing newer), every INSERT is ON CONFLICT DO NOTHING / NOT EXISTS, DROP
-- POLICY IF EXISTS, REVOKE and COMMENT repeat harmlessly. The helpers (section
-- 1) are mig 792 section 5 VERBATIM (tests/migration-792-landing-pages.test.js
-- pins their key lists to src/lib/landing-page-offers.js, and
-- tests/migration-795-landing-page-settings-closed.test.js pins these copies to
-- 792's); they exist for this file only and are dropped at its end (section 6).
--
-- What a re-sync never touches: offer_type, kind, scope, slug,
-- primary_location_id, organisation (the legacy editor never changed them); a
-- RETIRED page's publish_state; the studio row's enabled and sort_order; the
-- page chrome's meta_title, meta_description, tone, noindex and was_live (the
-- legacy table holds none of them); chrome.un1t_terms when the legacy row has no
-- class_funnel block (nothing to rebuild it from; it is not blanked).
-- The legacy table's logo and chooser columns replace the page's own: a column
-- the legacy editor cleared removes the page's key, it does not leave the old
-- value behind.
--
-- No GRANT to any client role anywhere in this file.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Backfill helpers (mig 792 section 5, verbatim)
-- ---------------------------------------------------------------------------
-- The PAGE half of an offer block: the block without the studio's keys, the
-- attribution keys, and the keys the page now owns itself. Any other block is
-- returned as it is.
CREATE OR REPLACE FUNCTION private.landing_page_block_page_half(b jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE b->>'type'
    WHEN 'paid_trial' THEN b
      - 'membership_id' - 'plan_code' - 'un1t_product_id' - 'price_cents' - 'currency'
      - 'duration_days' - 'product_name' - 'studio_label'
      - 'tag' - 'lead_source' - 'event_source_url'
    WHEN 'class_funnel' THEN b
      - 'trial_membership_id' - 'trial_plan_code' - 'price_cents' - 'currency' - 'consult_slug'
      - 'timetable' - 'timetable_start_date' - 'min_notice_hours'
      - 'tag' - 'lead_source' - 'event_source_url'
    WHEN 'campaign_funnel' THEN b
      - 'trial_membership_id' - 'trial_plan_code' - 'class_keywords'
      - 'tag' - 'lead_source' - 'event_source_url'
      - 'campaign' - 'show_sections'
    WHEN 'corp_promo' THEN b
      - 'promo_key'
      - 'tag' - 'lead_source' - 'event_source_url'
    ELSE b
  END
$$;

-- The STUDIO half of an offer block: {offer, attribution}. JSON nulls and (for
-- attribution) blank strings are not values and are left out.
CREATE OR REPLACE FUNCTION private.landing_page_block_studio_half(b jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'offer', COALESCE((
      SELECT jsonb_object_agg(e.key, e.value)
      FROM jsonb_each(b) AS e
      WHERE jsonb_typeof(e.value) <> 'null'
        AND e.key = ANY (CASE b->>'type'
          WHEN 'paid_trial' THEN ARRAY['membership_id', 'plan_code', 'un1t_product_id', 'price_cents', 'currency', 'duration_days', 'product_name', 'studio_label']
          WHEN 'class_funnel' THEN ARRAY['trial_membership_id', 'trial_plan_code', 'price_cents', 'currency', 'consult_slug', 'timetable', 'timetable_start_date', 'min_notice_hours']
          WHEN 'campaign_funnel' THEN ARRAY['trial_membership_id', 'trial_plan_code', 'class_keywords']
          WHEN 'corp_promo' THEN ARRAY['promo_key']
          ELSE ARRAY[]::text[]
        END)
    ), '{}'::jsonb),
    'attribution', COALESCE((
      SELECT jsonb_object_agg(e.key, e.value)
      FROM jsonb_each(b) AS e
      WHERE e.key = ANY (ARRAY['tag', 'lead_source', 'event_source_url'])
        AND jsonb_typeof(e.value) <> 'null'
        AND e.value <> '""'::jsonb
    ), '{}'::jsonb)
  )
$$;

-- The first block of a type (and, when asked, of a campaign), in array order.
CREATE OR REPLACE FUNCTION private.landing_page_first_block(blocks jsonb, block_type text, campaign text DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT e.b
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(blocks) = 'array' THEN blocks ELSE '[]'::jsonb END) WITH ORDINALITY AS e(b, ord)
  WHERE e.b->>'type' = block_type
    AND (campaign IS NULL OR e.b->>'campaign' = campaign)
  ORDER BY e.ord
  LIMIT 1
$$;

-- A studio page's blocks: every non-offer block in order, plus the first block
-- of the page's offer type as its page half. offer_type 'none' keeps no offer.
CREATE OR REPLACE FUNCTION private.landing_page_studio_blocks(blocks jsonb, offer_type text)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  WITH src AS (
    SELECT e.b, e.ord
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(blocks) = 'array' THEN blocks ELSE '[]'::jsonb END) WITH ORDINALITY AS e(b, ord)
  )
  SELECT COALESCE(jsonb_agg(private.landing_page_block_page_half(src.b) ORDER BY src.ord), '[]'::jsonb)
  FROM src
  WHERE COALESCE(src.b->>'type', '') NOT IN ('paid_trial', 'class_funnel', 'campaign_funnel', 'corp_promo')
     OR src.ord = (SELECT min(x.ord) FROM src AS x WHERE x.b->>'type' = offer_type)
$$;

-- A campaign page's content blocks: a studio's blocks without the hero, the
-- lead form and the offer blocks. With no only_types, every such block in
-- array order. With only_types (the /50plus show_sections list), the FIRST
-- block of each named type, emitted in only_types order: what the /50plus
-- route did (copy.show_sections.map(type => blocks.find(b => b.type === type))).
CREATE OR REPLACE FUNCTION private.landing_page_content_blocks(blocks jsonb, only_types text[] DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  WITH src AS (
    SELECT e.b, e.ord
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(blocks) = 'array' THEN blocks ELSE '[]'::jsonb END) WITH ORDINALITY AS e(b, ord)
    WHERE e.b->>'type' IS NOT NULL
      AND e.b->>'type' <> ALL (ARRAY['hero', 'lead_form', 'class_funnel', 'paid_trial', 'campaign_funnel', 'corp_promo'])
  ),
  firsts AS (
    SELECT DISTINCT ON (src.b->>'type') src.b
    FROM src
    WHERE src.b->>'type' = ANY (only_types)
    ORDER BY src.b->>'type', src.ord
  )
  SELECT CASE
    WHEN only_types IS NULL THEN (SELECT COALESCE(jsonb_agg(src.b ORDER BY src.ord), '[]'::jsonb) FROM src)
    ELSE (SELECT COALESCE(jsonb_agg(firsts.b ORDER BY array_position(only_types, firsts.b->>'type')), '[]'::jsonb) FROM firsts)
  END
$$;

-- The chrome object. Nulls are left out (a missing logo is no key).
CREATE OR REPLACE FUNCTION private.landing_page_backfill_chrome(
  logo_url text, logo_alt text, logo_width_px integer, show_instagram_feed boolean,
  chooser_label text, chooser_cta_text text, chooser_image_url text, noindex boolean, tone text)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'logo_url', logo_url,
    'logo_alt', logo_alt,
    'logo_width_px', logo_width_px,
    'show_instagram_feed', COALESCE(show_instagram_feed, true),
    'chooser_label', chooser_label,
    'chooser_cta_text', chooser_cta_text,
    'chooser_image_url', chooser_image_url,
    'noindex', noindex,
    'tone', tone
  ))
$$;

REVOKE EXECUTE ON FUNCTION private.landing_page_block_page_half(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION private.landing_page_block_studio_half(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION private.landing_page_first_block(jsonb, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION private.landing_page_studio_blocks(jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION private.landing_page_content_blocks(jsonb, text[]) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION private.landing_page_backfill_chrome(text, text, integer, boolean, text, text, text, boolean, text) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Re-sync: studio pages the legacy editor changed after mig 792
-- ---------------------------------------------------------------------------
-- The studio row first: the page UPDATE below makes p.updated_at newer than the
-- legacy row (the trigger stamps now()), which would hide the page from this
-- statement's condition. Only when the legacy row still holds a block of the
-- page's offer type (a page whose offer_type is 'none' never matches); enabled
-- and sort_order stay as they are.
UPDATE public.landing_page_studios AS ps
SET offer = sh.h->'offer',
    attribution = sh.h->'attribution'
FROM public.landing_page_settings AS s
JOIN public.locations AS l ON l.id = s.location_id
JOIN public.landing_pages AS p
  ON p.kind = 'studio'
 AND p.primary_location_id = s.location_id
 AND p.organization_id = l.organization_id
CROSS JOIN LATERAL (
  SELECT private.landing_page_block_studio_half(private.landing_page_first_block(s.blocks, p.offer_type)) AS h
) AS sh
WHERE ps.page_id = p.id
  AND ps.location_id = s.location_id
  AND s.public_path IS NOT NULL
  AND s.updated_at > p.updated_at
  AND private.landing_page_first_block(s.blocks, p.offer_type) IS NOT NULL;

-- The page: blocks (the page half of the offer type's block plus every
-- non-offer block), chrome (the legacy logo/chooser columns over the page's own
-- chrome, un1t_terms rebuilt as 792 section 6 does), publish_state (a retired
-- page stays retired). updated_at is not set here: the update_updated_at
-- trigger stamps now() (the apply time) on every row this touches, whatever
-- the statement says, which is also what makes a second run find nothing newer.
UPDATE public.landing_pages AS p
SET blocks = private.landing_page_studio_blocks(s.blocks, p.offer_type),
    chrome = (p.chrome - 'logo_url' - 'logo_alt' - 'logo_width_px' - 'chooser_label' - 'chooser_cta_text' - 'chooser_image_url')
      || private.landing_page_backfill_chrome(s.logo_url, s.logo_alt, s.logo_width_px, s.show_instagram_feed,
           s.chooser_label, s.chooser_cta_text, s.chooser_image_url, (p.chrome->>'noindex')::boolean, p.chrome->>'tone')
      || CASE WHEN cf.b IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('un1t_terms', jsonb_strip_nulls(jsonb_build_object(
           'terms_label', NULLIF(cf.b->>'terms_label', ''),
           'terms_link_label', NULLIF(cf.b->>'terms_link_label', ''),
           'waiver_link_label', NULLIF(cf.b->>'waiver_link_label', ''),
           'terms_required_message', NULLIF(cf.b->>'terms_required_message', ''),
           'legal_unavailable_message', NULLIF(cf.b->>'legal_unavailable_message', '')
         ))) END,
    publish_state = CASE WHEN p.publish_state = 'retired' THEN 'retired'
                         ELSE CASE s.publish_state WHEN 'live' THEN 'live' WHEN 'coming_soon' THEN 'coming_soon' ELSE 'draft' END
                    END
FROM public.landing_page_settings AS s
JOIN public.locations AS l ON l.id = s.location_id
CROSS JOIN LATERAL (SELECT private.landing_page_first_block(s.blocks, 'class_funnel') AS b) AS cf
WHERE p.kind = 'studio'
  AND p.primary_location_id = s.location_id
  AND p.organization_id = l.organization_id
  AND s.public_path IS NOT NULL
  AND s.updated_at > p.updated_at;

-- ---------------------------------------------------------------------------
-- 3. A legacy row with no studio page (none in prod on 31 Oct 2026)
-- ---------------------------------------------------------------------------
-- Mig 792 section 6, plus a NOT EXISTS on the location's studio page: a
-- location that already holds one under another slug would otherwise hit
-- landing_pages_one_studio_page, which ON CONFLICT (organization_id, slug) does
-- not cover.
INSERT INTO public.landing_pages
  (organization_id, slug, title, kind, scope, primary_location_id, offer_type, blocks, chrome, publish_state, created_at, updated_at)
SELECT
  l.organization_id,
  s.public_path,
  l.name,
  'studio',
  'one',
  s.location_id,
  ot.offer_type,
  private.landing_page_studio_blocks(s.blocks, ot.offer_type),
  private.landing_page_backfill_chrome(s.logo_url, s.logo_alt, s.logo_width_px, s.show_instagram_feed,
    s.chooser_label, s.chooser_cta_text, s.chooser_image_url, false, 'dark')
  || CASE WHEN cf.b IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('un1t_terms', jsonb_strip_nulls(jsonb_build_object(
       'terms_label', NULLIF(cf.b->>'terms_label', ''),
       'terms_link_label', NULLIF(cf.b->>'terms_link_label', ''),
       'waiver_link_label', NULLIF(cf.b->>'waiver_link_label', ''),
       'terms_required_message', NULLIF(cf.b->>'terms_required_message', ''),
       'legal_unavailable_message', NULLIF(cf.b->>'legal_unavailable_message', '')
     ))) END,
  CASE s.publish_state WHEN 'live' THEN 'live' WHEN 'coming_soon' THEN 'coming_soon' ELSE 'draft' END,
  s.updated_at,
  s.updated_at
FROM public.landing_page_settings AS s
JOIN public.locations AS l ON l.id = s.location_id
CROSS JOIN LATERAL (SELECT private.landing_page_first_block(s.blocks, 'class_funnel') AS b) AS cf
CROSS JOIN LATERAL (
  SELECT CASE
    WHEN private.landing_page_first_block(s.blocks, 'paid_trial') IS NOT NULL THEN 'paid_trial'
    WHEN private.landing_page_first_block(s.blocks, 'class_funnel') IS NOT NULL THEN 'class_funnel'
    ELSE 'none'
  END AS offer_type
) AS ot
WHERE s.public_path IS NOT NULL
  AND l.organization_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.landing_pages AS p2
    WHERE p2.kind = 'studio' AND p2.primary_location_id = s.location_id
  )
ON CONFLICT (organization_id, slug) DO NOTHING;

INSERT INTO public.landing_page_studios (page_id, location_id, enabled, offer, attribution, sort_order)
SELECT
  p.id,
  s.location_id,
  true,
  sh.h->'offer',
  sh.h->'attribution',
  0
FROM public.landing_page_settings AS s
JOIN public.locations AS l ON l.id = s.location_id
JOIN public.landing_pages AS p
  ON p.organization_id = l.organization_id AND p.slug = s.public_path
 AND p.kind = 'studio' AND p.primary_location_id = s.location_id
CROSS JOIN LATERAL (
  SELECT private.landing_page_block_studio_half(private.landing_page_first_block(s.blocks, p.offer_type)) AS h
) AS sh
WHERE s.public_path IS NOT NULL
ON CONFLICT (page_id, location_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. Missing all-studios rows, switched off
-- ---------------------------------------------------------------------------
-- Every (scope = 'all' page, active studio of its organisation) pair with no
-- landing_page_studios row gets one, enabled = false with an empty offer, so the
-- editor lists the studio and staff configure and switch it on. sort_order
-- continues after the page's highest existing one, in the studios' creation
-- order. A row that exists is never touched. A host-event anchor location
-- (locations.is_host_anchor, mig 388: "Pride Training Club (host events)") is
-- not a studio and gets no row, as every studio list in the app excludes it.
INSERT INTO public.landing_page_studios (page_id, location_id, enabled, offer, attribution, sort_order)
SELECT
  p.id,
  l.id,
  false,
  '{}'::jsonb,
  '{}'::jsonb,
  COALESCE((SELECT max(x.sort_order) + 1 FROM public.landing_page_studios AS x WHERE x.page_id = p.id), 0)
    + (row_number() OVER (PARTITION BY p.id ORDER BY l.created_at, l.id) - 1)::integer
FROM public.landing_pages AS p
JOIN public.locations AS l ON l.organization_id = p.organization_id AND l.active
  AND NOT COALESCE(l.is_host_anchor, false)
WHERE p.scope = 'all'
  AND NOT EXISTS (
    SELECT 1 FROM public.landing_page_studios AS e
    WHERE e.page_id = p.id AND e.location_id = l.id
  )
ON CONFLICT (page_id, location_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 5. The old table is closed and dated for drop
-- ---------------------------------------------------------------------------
-- Nothing reads it (PR1-PR3). It held table-level grants to authenticated and
-- four policies: landing_page_settings_public_read TO anon, authenticated, and
-- the _ins, _upd and _del write policies TO authenticated; every one goes. RLS stays on with no policy. The
-- landing_page_settings_touch_updated_at trigger stays (harmless). The data
-- stays for rollback until the drop migration.
REVOKE ALL ON public.landing_page_settings FROM anon, authenticated, PUBLIC;

DROP POLICY IF EXISTS landing_page_settings_del ON public.landing_page_settings;
DROP POLICY IF EXISTS landing_page_settings_ins ON public.landing_page_settings;
DROP POLICY IF EXISTS landing_page_settings_upd ON public.landing_page_settings;
DROP POLICY IF EXISTS landing_page_settings_public_read ON public.landing_page_settings;

COMMENT ON TABLE public.landing_page_settings IS 'DEPRECATED (mig 792): unread since PR3 (mig 795, 2026-10-31); drop in a later migration after 2026-12-01.';

-- ---------------------------------------------------------------------------
-- 6. The backfill helpers go again (mig 792 section 12)
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS private.landing_page_backfill_chrome(text, text, integer, boolean, text, text, text, boolean, text);
DROP FUNCTION IF EXISTS private.landing_page_content_blocks(jsonb, text[]);
DROP FUNCTION IF EXISTS private.landing_page_studio_blocks(jsonb, text);
DROP FUNCTION IF EXISTS private.landing_page_first_block(jsonb, text, text);
DROP FUNCTION IF EXISTS private.landing_page_block_studio_half(jsonb);
DROP FUNCTION IF EXISTS private.landing_page_block_page_half(jsonb);

COMMIT;
