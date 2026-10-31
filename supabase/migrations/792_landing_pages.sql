-- 792_landing_pages.sql  (PAGES.1)
--
-- Public marketing pages become records. Until now one row per studio in
-- landing_page_settings (keyed on location_id, public_path = the URL) held the
-- whole page, and /trial, /50plus, /corp, /start and /free-class were routes
-- in code that borrowed a studio's blocks. This migration adds:
--   * public.landing_pages        one row per PAGE: slug, kind (studio |
--                                 campaign), scope (one studio | all), the
--                                 offer type, the blocks, the chrome, the
--                                 publish state, a retired page's redirect;
--   * public.landing_page_studios one row per PAGE AND STUDIO: the studio half
--                                 of the offer (plan ids, class keywords,
--                                 price: `offer`) and its attribution (tag,
--                                 lead source, event source url), plus
--                                 whether the page is switched on there;
--   * page_id on the four request tables, so a request names its page.
-- It backfills the seven pages that exist today from landing_page_settings and
-- leaves that table in place, deprecated: the studio pages keep reading it
-- until PR3, a later migration drops it. Design:
-- docs/superpowers/specs/2026-10-30-landing-pages-editor-design.md (sections 1, 6).
--
-- The split of an offer block (which keys are the studio's) is
-- STUDIO_OFFER_KEYS / ATTRIBUTION_KEYS / DROPPED_BLOCK_KEYS in
-- src/lib/landing-page-offers.js; private.landing_page_block_page_half and
-- private.landing_page_block_studio_half below spell the same lists in SQL, and
-- tests/migration-792-landing-pages.test.js pins the two together. Edit both.
--
-- Access: both tables are closed to every client session (RLS on, no policy,
-- no grant to anon/authenticated): every read and write is a service-role
-- route, judged in app code. The org-membership and manager checks live in the
-- routes; the database refuses only a studio row outside the page's
-- organisation (landing_page_studios_same_org).
--
-- Idempotent: tables IF NOT EXISTS, columns ADD COLUMN IF NOT EXISTS, functions
-- CREATE OR REPLACE, triggers DROP then CREATE, every backfill row ON CONFLICT
-- DO NOTHING. A missing backfill source inserts nothing and never fails the
-- migration: no `stillorgan` row means no studio, trial, 50plus or retired
-- pages from it; no `paid_trial` block on Stillorgan means no /trial; no
-- `campaign_funnel` block with campaign '50plus' means no /50plus; no Hatch
-- `corp_promo` block means no /corp. UN1T Group's organisation is never named:
-- it is the organisation of the location behind public_path = 'stillorgan'.
-- landing_page_settings has no created_at, so a backfilled studio page takes
-- its updated_at for both. A NULL (or non-array) blocks column backfills as [].
--
-- All four request tables exist (class_booking_requests mig 335,
-- trial_purchases mig 762, corp_promo_claims mig 787, funnel_events mig 376).
-- page_id gets no index in this file (nothing reads it yet; a later migration
-- adds the four CONCURRENTLY). lock_timeout 5s (mig 733 pattern): the ALTERs
-- on the request tables give up rather than queue behind a long writer.
-- The offer block's JSON nulls are dropped from the studio half (a null plan
-- code is not a value); the page half keeps every other key as it was.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. landing_pages
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.landing_pages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  slug                text NOT NULL,
  title               text NOT NULL,
  kind                text NOT NULL CHECK (kind IN ('studio', 'campaign')),
  scope               text NOT NULL CHECK (scope IN ('one', 'all')),
  primary_location_id uuid REFERENCES public.locations(id) ON DELETE RESTRICT,
  offer_type          text NOT NULL DEFAULT 'none'
                        CHECK (offer_type IN ('paid_trial', 'class_funnel', 'one_class', 'promo_credits', 'none')),
  blocks              jsonb NOT NULL DEFAULT '[]'::jsonb,
  chrome              jsonb NOT NULL DEFAULT '{}'::jsonb,
  publish_state       text NOT NULL DEFAULT 'draft'
                        CHECK (publish_state IN ('draft', 'live', 'coming_soon', 'retired')),
  redirect_to         text,
  created_by          uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_by          uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT landing_pages_org_slug_key UNIQUE (organization_id, slug),
  CONSTRAINT landing_pages_scope_location_check CHECK ((scope = 'one') = (primary_location_id IS NOT NULL)),
  CONSTRAINT landing_pages_redirect_only_retired CHECK ((publish_state = 'retired') OR (redirect_to IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS landing_pages_one_studio_page
  ON public.landing_pages (primary_location_id) WHERE kind = 'studio';

COMMENT ON TABLE public.landing_pages IS
  'PAGES.1 (mig 792): one row per public marketing page (a studio page or a campaign page). The page half of the offer lives in blocks; the studio half in landing_page_studios. Service-role only.';

-- ---------------------------------------------------------------------------
-- 2. landing_page_studios
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.landing_page_studios (
  page_id     uuid NOT NULL REFERENCES public.landing_pages(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  enabled     boolean NOT NULL DEFAULT false,
  offer       jsonb NOT NULL DEFAULT '{}'::jsonb,
  attribution jsonb NOT NULL DEFAULT '{}'::jsonb,
  sort_order  integer NOT NULL DEFAULT 0,
  updated_by  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (page_id, location_id)
);

CREATE INDEX IF NOT EXISTS idx_landing_page_studios_location
  ON public.landing_page_studios (location_id);

COMMENT ON TABLE public.landing_page_studios IS
  'PAGES.1 (mig 792): the studio half of a page''s offer (offer, attribution) and whether the page is switched on at that studio. Service-role only.';

-- A studio row may never cross organisations (shape of mig 743's refusal on
-- location_whatsapp_numbers).
CREATE OR REPLACE FUNCTION public.landing_page_studios_same_org()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_page_org uuid;
  v_location_org uuid;
BEGIN
  SELECT organization_id INTO v_page_org FROM public.landing_pages WHERE id = NEW.page_id;
  SELECT organization_id INTO v_location_org FROM public.locations WHERE id = NEW.location_id;
  IF v_location_org IS DISTINCT FROM v_page_org THEN
    RAISE EXCEPTION 'landing_page_studios: location % is not in the page''s organisation', NEW.location_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.landing_page_studios_same_org() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS landing_page_studios_same_org ON public.landing_page_studios;
CREATE TRIGGER landing_page_studios_same_org
  BEFORE INSERT OR UPDATE ON public.landing_page_studios
  FOR EACH ROW EXECUTE FUNCTION public.landing_page_studios_same_org();

-- ---------------------------------------------------------------------------
-- 3. Closed to clients, updated_at, audit
-- ---------------------------------------------------------------------------
ALTER TABLE public.landing_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.landing_page_studios ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.landing_pages FROM anon, authenticated;
REVOKE ALL ON public.landing_page_studios FROM anon, authenticated;

DROP TRIGGER IF EXISTS trg_landing_pages_updated_at ON public.landing_pages;
CREATE TRIGGER trg_landing_pages_updated_at BEFORE UPDATE ON public.landing_pages
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
DROP TRIGGER IF EXISTS trg_landing_page_studios_updated_at ON public.landing_page_studios;
CREATE TRIGGER trg_landing_page_studios_updated_at BEFORE UPDATE ON public.landing_page_studios
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- private.log_mutation (mig 733): optional key column and actor column.
DROP TRIGGER IF EXISTS audit_mutation ON public.landing_pages;
CREATE TRIGGER audit_mutation AFTER INSERT OR UPDATE OR DELETE ON public.landing_pages
  FOR EACH ROW EXECUTE FUNCTION private.log_mutation('id', 'updated_by');
DROP TRIGGER IF EXISTS audit_mutation ON public.landing_page_studios;
CREATE TRIGGER audit_mutation AFTER INSERT OR UPDATE OR DELETE ON public.landing_page_studios
  FOR EACH ROW EXECUTE FUNCTION private.log_mutation('page_id', 'updated_by');

-- ---------------------------------------------------------------------------
-- 4. page_id on the request tables (SET NULL: a deleted page keeps the history)
-- ---------------------------------------------------------------------------
ALTER TABLE public.class_booking_requests ADD COLUMN IF NOT EXISTS page_id uuid REFERENCES public.landing_pages(id) ON DELETE SET NULL;
ALTER TABLE public.trial_purchases ADD COLUMN IF NOT EXISTS page_id uuid REFERENCES public.landing_pages(id) ON DELETE SET NULL;
ALTER TABLE public.corp_promo_claims ADD COLUMN IF NOT EXISTS page_id uuid REFERENCES public.landing_pages(id) ON DELETE SET NULL;
ALTER TABLE public.funnel_events ADD COLUMN IF NOT EXISTS page_id uuid REFERENCES public.landing_pages(id) ON DELETE SET NULL;

-- No index on page_id here: nothing reads it yet, and an index build inside
-- this transaction would hold the four tables' write lock. A later migration
-- adds them CONCURRENTLY when a reader lands.

-- ---------------------------------------------------------------------------
-- 5. Backfill helpers (pure; the same lists as src/lib/landing-page-offers.js)
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
-- 6. Backfill 1: one studio page per landing_page_settings row with a public_path
-- ---------------------------------------------------------------------------
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
  -- un1t_terms: the un1t.online terms-tick wording off the row's first
  -- class_funnel block (UN1T_FUNNEL_COPY_KEYS in
  -- src/lib/un1t-online-funnel-copy.js, edit the two together). The studio
  -- page keeps no class_funnel block when its offer is paid_trial, so this is
  -- the copy's home on the new rows; PR1 still reads landing_page_settings
  -- (studioTermsCopy). Absent when the row has no class_funnel block.
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
ON CONFLICT (organization_id, slug) DO NOTHING;

-- Its one studio row: switched on, the studio half of the kept offer block.
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
-- 7. Backfill 2: /trial (all studios, the 14 Day Reset)
-- ---------------------------------------------------------------------------
INSERT INTO public.landing_pages
  (organization_id, slug, title, kind, scope, primary_location_id, offer_type, blocks, chrome, publish_state)
SELECT
  l.organization_id,
  'trial',
  '14 Day Reset',
  'campaign',
  'all',
  NULL,
  'paid_trial',
  jsonb_build_array(private.landing_page_block_page_half(pt.b)) || private.landing_page_content_blocks(s.blocks),
  private.landing_page_backfill_chrome(s.logo_url, s.logo_alt, s.logo_width_px, s.show_instagram_feed,
    s.chooser_label, s.chooser_cta_text, s.chooser_image_url, true, 'dark'),
  'live'
FROM public.landing_page_settings AS s
JOIN public.locations AS l ON l.id = s.location_id
CROSS JOIN LATERAL (SELECT private.landing_page_first_block(s.blocks, 'paid_trial') AS b) AS pt
WHERE s.public_path = 'stillorgan'
  AND l.organization_id IS NOT NULL
  AND pt.b IS NOT NULL
ON CONFLICT (organization_id, slug) DO NOTHING;

-- Stillorgan (sort 0) and Hatch Street (sort 1), each from its own paid_trial block.
INSERT INTO public.landing_page_studios (page_id, location_id, enabled, offer, attribution, sort_order)
SELECT
  p.id,
  s.location_id,
  true,
  sh.h->'offer',
  sh.h->'attribution',
  CASE s.public_path WHEN 'stillorgan' THEN 0 ELSE 1 END
FROM public.landing_page_settings AS s
JOIN public.locations AS l ON l.id = s.location_id
JOIN public.landing_pages AS p
  ON p.organization_id = l.organization_id AND p.slug = 'trial' AND p.kind = 'campaign'
CROSS JOIN LATERAL (SELECT private.landing_page_first_block(s.blocks, 'paid_trial') AS b) AS pt
CROSS JOIN LATERAL (SELECT private.landing_page_block_studio_half(pt.b) AS h) AS sh
WHERE s.public_path IN ('stillorgan', 'hatch-street')
  AND pt.b IS NOT NULL
ON CONFLICT (page_id, location_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 8. Backfill 3: /50plus (Stillorgan only, one free class)
-- ---------------------------------------------------------------------------
INSERT INTO public.landing_pages
  (organization_id, slug, title, kind, scope, primary_location_id, offer_type, blocks, chrome, publish_state)
SELECT
  l.organization_id,
  '50plus',
  'The 50+ Club',
  'campaign',
  'one',
  s.location_id,
  'one_class',
  jsonb_build_array(private.landing_page_block_page_half(cf.b)) || private.landing_page_content_blocks(
    s.blocks,
    CASE WHEN jsonb_typeof(cf.b->'show_sections') = 'array'
      THEN ARRAY(SELECT jsonb_array_elements_text(cf.b->'show_sections'))
      ELSE ARRAY['stats', 'video_testimonials', 'reviews']
    END),
  private.landing_page_backfill_chrome(s.logo_url, s.logo_alt, s.logo_width_px, s.show_instagram_feed,
    s.chooser_label, s.chooser_cta_text, s.chooser_image_url, true, 'light'),
  'live'
FROM public.landing_page_settings AS s
JOIN public.locations AS l ON l.id = s.location_id
CROSS JOIN LATERAL (SELECT private.landing_page_first_block(s.blocks, 'campaign_funnel', '50plus') AS b) AS cf
WHERE s.public_path = 'stillorgan'
  AND l.organization_id IS NOT NULL
  AND cf.b IS NOT NULL
ON CONFLICT (organization_id, slug) DO NOTHING;

-- Attribution falls back to the values /50plus has always used when the block's are blank.
INSERT INTO public.landing_page_studios (page_id, location_id, enabled, offer, attribution, sort_order)
SELECT
  p.id,
  s.location_id,
  true,
  sh.h->'offer',
  jsonb_build_object('tag', 'stillorgan-50plus', 'lead_source', 'meta_50plus') || (sh.h->'attribution'),
  0
FROM public.landing_page_settings AS s
JOIN public.locations AS l ON l.id = s.location_id
JOIN public.landing_pages AS p
  ON p.organization_id = l.organization_id AND p.slug = '50plus' AND p.kind = 'campaign'
CROSS JOIN LATERAL (SELECT private.landing_page_first_block(s.blocks, 'campaign_funnel', '50plus') AS b) AS cf
CROSS JOIN LATERAL (SELECT private.landing_page_block_studio_half(cf.b) AS h) AS sh
WHERE s.public_path = 'stillorgan'
  AND cf.b IS NOT NULL
ON CONFLICT (page_id, location_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 9. Backfill 4: /corp (Hatch Street, promo credits)
-- ---------------------------------------------------------------------------
INSERT INTO public.landing_pages
  (organization_id, slug, title, kind, scope, primary_location_id, offer_type, blocks, chrome, publish_state)
SELECT
  l.organization_id,
  'corp',
  'Corporate promo',
  'campaign',
  'one',
  s.location_id,
  'promo_credits',
  jsonb_build_array(private.landing_page_block_page_half(cp.b)) || private.landing_page_content_blocks(s.blocks),
  private.landing_page_backfill_chrome(s.logo_url, s.logo_alt, s.logo_width_px, s.show_instagram_feed,
    s.chooser_label, s.chooser_cta_text, s.chooser_image_url, true, 'dark'),
  'live'
FROM public.landing_page_settings AS s
JOIN public.locations AS l ON l.id = s.location_id
CROSS JOIN LATERAL (SELECT private.landing_page_first_block(s.blocks, 'corp_promo') AS b) AS cp
WHERE s.public_path = 'hatch-street'
  AND l.organization_id IS NOT NULL
  AND cp.b IS NOT NULL
ON CONFLICT (organization_id, slug) DO NOTHING;

INSERT INTO public.landing_page_studios (page_id, location_id, enabled, offer, attribution, sort_order)
SELECT
  p.id,
  s.location_id,
  true,
  jsonb_build_object('promo_key', COALESCE(NULLIF(cp.b->>'promo_key', ''), 'hatch-3-free')),
  (private.landing_page_block_studio_half(cp.b))->'attribution',
  0
FROM public.landing_page_settings AS s
JOIN public.locations AS l ON l.id = s.location_id
JOIN public.landing_pages AS p
  ON p.organization_id = l.organization_id AND p.slug = 'corp' AND p.kind = 'campaign'
CROSS JOIN LATERAL (SELECT private.landing_page_first_block(s.blocks, 'corp_promo') AS b) AS cp
WHERE s.public_path = 'hatch-street'
  AND cp.b IS NOT NULL
ON CONFLICT (page_id, location_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 10. Backfill 5: /start and /free-class, retired, sent to the trial page
-- ---------------------------------------------------------------------------
INSERT INTO public.landing_pages
  (organization_id, slug, title, kind, scope, primary_location_id, offer_type, blocks, chrome, publish_state, redirect_to)
SELECT l.organization_id, v.slug, v.title, 'campaign', 'one', s.location_id, 'none', '[]'::jsonb, '{}'::jsonb, 'retired', '/trial?studio=stillorgan'
FROM public.landing_page_settings AS s
JOIN public.locations AS l ON l.id = s.location_id
CROSS JOIN (VALUES ('start', 'Start (retired)'), ('free-class', 'Free class (retired)')) AS v(slug, title)
WHERE s.public_path = 'stillorgan'
  AND l.organization_id IS NOT NULL
ON CONFLICT (organization_id, slug) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 11. The old table is deprecated, not dropped
-- ---------------------------------------------------------------------------
COMMENT ON TABLE public.landing_page_settings IS 'DEPRECATED (mig 792): replaced by landing_pages + landing_page_studios. Read by the studio pages until PR3; dropped by a later migration.';

COMMIT;
