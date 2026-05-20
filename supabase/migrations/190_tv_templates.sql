-- TV-TEMPLATE.1 — base-image templates for TV displays.
--
-- WHY
-- ───
-- Operators want to put quick on-the-fly messages on the lobby TV
-- ("Welcome Sarah", "Class at 6 — 2 spots left") without designing
-- a fresh image in Canva every time. The ask: a fixed branded base
-- image, with a few text zones laid over it that any staff member
-- can re-type and push.
--
-- WHAT
-- ────
--   1. tv_templates — a reusable design. base_image_path points at
--      an image in the existing public 'tv-content' bucket (mig
--      160). `zones` is a JSONB array of fixed text-box definitions
--      — position, size and style are set once when the template
--      is built and never change; only the text inside them does.
--
--      Zone object shape (positions are % of the base image, so a
--      template renders identically at any panel resolution):
--        {
--          "id":          "z1",        -- stable key
--          "label":       "Headline",  -- shown to the staff filler
--          "x": 8, "y": 12,            -- top-left, % of image
--          "width": 84, "height": 22,  -- box size, % of image
--          "fontSize": 9,              -- % of image height
--          "fontWeight": 800,
--          "color": "#FFFFFF",
--          "align": "center",          -- left | center | right
--          "vAlign": "middle",         -- top | middle | bottom
--          "uppercase": true,
--          "defaultText": ""           -- pre-fill when pushing
--        }
--
--   2. tv_content gains 'template' as a source_type. For a template
--      push: source_ref holds the tv_templates.id and a new
--      template_values JSONB column holds the per-zone text the
--      staff member typed — { "<zoneId>": "Welcome Sarah", ... }.
--      The base image never lives in template_values; it's resolved
--      from the template row, so it stays constant across pushes.
--
-- The public /tv/cast page reads via the service-role content API
-- (bypasses RLS); the admin path uses the authenticated browser
-- client, so tv_templates gets the same location-scoped RLS as
-- tv_displays / tv_content.

BEGIN;

CREATE TABLE IF NOT EXISTS tv_templates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id     UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  -- Path inside the public 'tv-content' bucket. The branded base
  -- the text zones sit on top of — set once, never edited per push.
  base_image_path TEXT NOT NULL,
  -- Fixed text-zone definitions (see header for the object shape).
  zones           JSONB NOT NULL DEFAULT '[]'::JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      UUID REFERENCES profiles(id) ON DELETE SET NULL,
  UNIQUE (location_id, name)
);

COMMENT ON TABLE tv_templates IS
  'TV-TEMPLATE.1 — reusable TV designs: one fixed branded base image plus fixed text zones. Staff fill the zone text and push; the base image stays constant.';
COMMENT ON COLUMN tv_templates.zones IS
  'TV-TEMPLATE.1 — JSONB array of fixed text-zone defs. Each: id,label,x,y,width,height (% of base image), fontSize (% of image height), fontWeight,color,align,vAlign,uppercase,defaultText.';

CREATE INDEX IF NOT EXISTS idx_tv_templates_location ON tv_templates (location_id);

ALTER TABLE tv_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY tv_templates_location_scoped
  ON tv_templates
  TO authenticated
  USING (private.auth_is_in_location(location_id))
  WITH CHECK (private.auth_is_in_location(location_id));

-- ============================================================
-- tv_content: allow 'template' as a source.

ALTER TABLE tv_content DROP CONSTRAINT IF EXISTS tv_content_source_type_check;
ALTER TABLE tv_content ADD CONSTRAINT tv_content_source_type_check
  CHECK (source_type IN ('storage','url','generated','template'));

-- Per-zone text for a template push: { "<zoneId>": "<text>", ... }.
-- NULL for non-template content. The zone *layout* lives on the
-- template; only the typed text lives here.
ALTER TABLE tv_content
  ADD COLUMN IF NOT EXISTS template_values JSONB;

COMMENT ON COLUMN tv_content.template_values IS
  'TV-TEMPLATE.1 — for source_type=''template'': per-zone text keyed by zone id. source_ref holds the tv_templates.id. NULL for storage/url content.';

COMMIT;
