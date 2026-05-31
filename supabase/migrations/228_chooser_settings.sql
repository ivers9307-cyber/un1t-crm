-- 228: editable front page (un1tdublin.com chooser) + per-tile fields
--
-- chooser_settings is a singleton (id='default') holding page-level
-- chooser config: an optional headline/intro across the split, and the
-- left->right tile order (array of landing_page_settings.public_path).
-- Per-tile label/CTA overrides live on landing_page_settings next to
-- the existing chooser_image_url.

CREATE TABLE IF NOT EXISTS chooser_settings (
  id          text PRIMARY KEY DEFAULT 'default' CHECK (id = 'default'),
  headline    text,
  intro       text,
  tile_order  jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid
);

ALTER TABLE chooser_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS chooser_settings_public_read ON chooser_settings;
CREATE POLICY chooser_settings_public_read ON chooser_settings
  FOR SELECT USING (true);

DROP POLICY IF EXISTS chooser_settings_write ON chooser_settings;
CREATE POLICY chooser_settings_write ON chooser_settings
  FOR ALL USING (
    EXISTS (SELECT 1 FROM profiles p
            WHERE p.id = auth.uid() AND (p.role = 'master' OR p.role = 'owner'))
  );

ALTER TABLE landing_page_settings ADD COLUMN IF NOT EXISTS chooser_label    text;
ALTER TABLE landing_page_settings ADD COLUMN IF NOT EXISTS chooser_cta_text text;

INSERT INTO chooser_settings (id, tile_order)
VALUES ('default', '["stillorgan","hatch-street"]'::jsonb)
ON CONFLICT (id) DO NOTHING;
