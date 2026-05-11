-- ============================================================
-- 126: landing_page_settings — operator-editable copy + media for
-- the public marketing landing page at /welcome (Phase 2 of the
-- landing-page work; Phase 1 was the hand-coded React component
-- in src/app/welcome/page.js).
--
-- One row per location. The page render picks the first matching
-- row (today UN1T has one location active for marketing; multi-
-- location routing can add a hostname-or-location-param picker
-- later). All-NULL row = page falls back to the hard-coded
-- defaults baked into welcome/page.js so the public surface
-- never breaks.
--
-- JSONB columns (pillars, stats) instead of separate child tables
-- because:
--   - Always 3 of each in the layout — a child table is overkill
--   - Operator edits all of them in one form save
--   - JSONB lets us evolve the per-item shape without an ALTER
--   - No reporting/aggregation use case that needs joinable rows
--
-- RLS:
--   - Public anon SELECT — the /welcome page renders unauthenticated
--     so the unauthenticated supabase client must be able to read.
--     Safe because the columns hold no PII (just hero copy + image
--     URL + booking slug).
--   - Master/owner INSERT/UPDATE — settings UI is master/owner only
--     (matches the per-location feature-flag pattern from mig 110).
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.landing_page_settings (
  location_id           UUID PRIMARY KEY REFERENCES public.locations(id) ON DELETE CASCADE,

  -- Hero block — eyebrow line above the headline, the headline
  -- itself (split into two visual lines via hero_subhead — the
  -- second line renders in the muted-foreground colour), and a
  -- supporting paragraph below.
  hero_eyebrow          TEXT,
  hero_headline         TEXT,
  hero_subhead          TEXT,
  hero_subtext          TEXT,

  -- Slug of the event_type whose BookingWidget is embedded as the
  -- conversion form. Must match an active row in event_types.slug.
  -- NULL => fall back to the const baked into welcome/page.js.
  booking_slug          TEXT,

  -- Optional hero background image. Public Supabase Storage URL.
  -- When set, the welcome page swaps the radial-gradient backdrop
  -- for this image with a darkening overlay so the headline stays
  -- legible.
  hero_image_url        TEXT,

  -- 3 value-prop pillars rendered in the "What we do" section.
  -- Shape: [{ number: "01", title: "...", body: "..." }, ...]
  pillars               JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- 3 stat tiles in the social-proof section.
  -- Shape: [{ number: "200+", label: "..." }, ...]
  stats                 JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Single member testimonial.
  testimonial_quote     TEXT,
  testimonial_author    TEXT,

  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by            UUID REFERENCES public.profiles(id) ON DELETE SET NULL
);

COMMENT ON TABLE public.landing_page_settings IS
  'Operator-editable copy + media for the public landing page at /welcome. One row per location; render falls back to hard-coded defaults in src/app/welcome/page.js when a column is NULL or the row is absent. Mig 126 (Phase 2 of landing-page work).';

ALTER TABLE public.landing_page_settings ENABLE ROW LEVEL SECURITY;

-- Public read — /welcome serves unauthenticated visitors. No PII
-- in this table; settings are public branding by design.
DROP POLICY IF EXISTS landing_page_settings_public_read ON public.landing_page_settings;
CREATE POLICY landing_page_settings_public_read ON public.landing_page_settings
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- Write gated to master OR owner at the row's location. Matches
-- the master-or-location-owner pattern used by other branding
-- surfaces (BrandingSettings, mig 126 era).
DROP POLICY IF EXISTS landing_page_settings_master_owner_write ON public.landing_page_settings;
CREATE POLICY landing_page_settings_master_owner_write ON public.landing_page_settings
  FOR ALL
  TO authenticated
  USING (
    private.auth_is_master()
    OR EXISTS (
      SELECT 1 FROM public.profile_locations pl
      WHERE pl.profile_id = auth.uid()
        AND pl.location_id = landing_page_settings.location_id
        AND pl.role = 'owner'
    )
  )
  WITH CHECK (
    private.auth_is_master()
    OR EXISTS (
      SELECT 1 FROM public.profile_locations pl
      WHERE pl.profile_id = auth.uid()
        AND pl.location_id = landing_page_settings.location_id
        AND pl.role = 'owner'
    )
  );

CREATE OR REPLACE FUNCTION private.touch_landing_page_settings_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN NEW.updated_at := NOW(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS landing_page_settings_touch_updated_at ON public.landing_page_settings;
CREATE TRIGGER landing_page_settings_touch_updated_at
  BEFORE UPDATE ON public.landing_page_settings
  FOR EACH ROW EXECUTE FUNCTION private.touch_landing_page_settings_updated_at();

COMMIT;
