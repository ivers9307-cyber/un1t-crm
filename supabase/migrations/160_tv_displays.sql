-- ============================================================
-- 160: TV.1 — TV display registration + push surface
-- ============================================================
--
-- WHY THIS MIGRATION EXISTS
-- ─────────────────────────
-- UN1T runs a TV in the gym lobby through UniFi UC Cast Pro.
-- The Pro tier supports "Web URL" as a content source, so we
-- can point the cast at a CRM-served URL and control what the
-- TV shows entirely from the CRM. Bypasses needing to wrap
-- UniFi Connect's content-management API (which Ubiquiti has
-- not publicly documented).
--
-- WHAT THIS MIGRATION DOES
-- ────────────────────────
--   1. tv_displays — each TV registered against a location. The
--      `token` column is a UUID used as the public URL slug
--      (https://crm/tv/<token>). Treating the token as a bearer
--      secret means we don't need auth on the /tv route — UC Cast
--      can't supply cookies, and the cast itself is the operator's
--      hardware so token-as-URL is acceptable.
--
--   2. tv_content — the CURRENT content for each TV. At most one
--      row per tv_display (PRIMARY KEY = tv_display_id). New
--      pushes UPSERT this row. The TV page polls /api/tv/[token]/
--      content every ~3s and swaps when pushed_at changes.
--
--   3. storage.buckets row for 'tv-content' — public-read bucket
--      where uploaded images live. Public read is fine: the URLs
--      are unguessable (UUID filenames) and the content is
--      operator-curated marketing material anyway.
--
--   4. RLS scoped to authenticated-in-location operators for both
--      tables (same pattern as campaigns / activities).

BEGIN;

CREATE TABLE IF NOT EXISTS tv_displays (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  -- token is the bearer secret embedded in the /tv/<token> URL.
  -- UUID-shaped so an attacker can't trivially enumerate. The TV
  -- itself stores this URL in its UC Cast config; operators copy
  -- it out of the CRM once and paste it into the cast UI.
  token       TEXT NOT NULL UNIQUE DEFAULT gen_random_uuid()::TEXT,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (location_id, label)
);

COMMENT ON TABLE tv_displays IS
  'TV.1 — physical TVs at each location. Each row maps to one UC Cast Pro device. The token is the public-URL slug the cast points at.';

CREATE INDEX IF NOT EXISTS idx_tv_displays_location ON tv_displays (location_id);
CREATE INDEX IF NOT EXISTS idx_tv_displays_token    ON tv_displays (token);

ALTER TABLE tv_displays ENABLE ROW LEVEL SECURITY;

CREATE POLICY tv_displays_location_scoped
  ON tv_displays
  TO authenticated
  USING (private.auth_is_in_location(location_id))
  WITH CHECK (private.auth_is_in_location(location_id));

-- ============================================================

CREATE TABLE IF NOT EXISTS tv_content (
  tv_display_id UUID PRIMARY KEY REFERENCES tv_displays(id) ON DELETE CASCADE,
  -- source_type:
  --   'storage'   — Supabase Storage path in source_ref. The /tv page
  --                 renders <img src="<bucket public URL>/<path>">.
  --   'url'       — arbitrary external URL in source_ref. The /tv page
  --                 renders <img src="<url>">. Useful for operator-
  --                 pasted links from anywhere.
  --   'generated' — generator key in source_ref (e.g. 'leaderboard:today').
  --                 Phase 2 work — Phase 1 only handles storage + url
  --                 + the implicit idle fallback when no row exists.
  source_type   TEXT NOT NULL CHECK (source_type IN ('storage','url','generated')),
  source_ref    TEXT NOT NULL,
  label         TEXT,
  pushed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  pushed_by     UUID REFERENCES profiles(id) ON DELETE SET NULL,
  triggered_by  TEXT
);

COMMENT ON TABLE tv_content IS
  'TV.1 — current content for each TV. One row per tv_display. New pushes UPSERT this row; clearing the screen deletes it (TV falls back to idle).';

ALTER TABLE tv_content ENABLE ROW LEVEL SECURITY;

-- Operators at the TV's location can manage content; the /tv page
-- itself goes through the service-role /api/tv/[token]/content
-- endpoint so it bypasses RLS by design.
CREATE POLICY tv_content_location_scoped
  ON tv_content
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM tv_displays d
      WHERE d.id = tv_content.tv_display_id
        AND private.auth_is_in_location(d.location_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM tv_displays d
      WHERE d.id = tv_content.tv_display_id
        AND private.auth_is_in_location(d.location_id)
    )
  );

-- ============================================================
-- Storage bucket for uploaded TV content. Public-read because
-- the cast loads images directly from this URL without auth.
-- Filenames are UUID-prefixed so enumeration is infeasible.

INSERT INTO storage.buckets (id, name, public)
VALUES ('tv-content', 'tv-content', TRUE)
ON CONFLICT (id) DO NOTHING;

-- Authenticated operators can write to tv-content/<location_id>/...
-- (the upload code prefixes paths by location). Service role can
-- write anywhere. anon role can read (public bucket).
CREATE POLICY "tv_content_storage_write"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'tv-content'
  );

CREATE POLICY "tv_content_storage_delete"
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'tv-content'
  );

COMMIT;
