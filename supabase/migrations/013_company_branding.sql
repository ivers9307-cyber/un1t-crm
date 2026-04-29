-- ============================================================
-- 013: Company Branding Settings
-- Store company logo and favicon per location.
-- Images stored in Supabase Storage 'branding' bucket.
-- ============================================================

-- Company settings table (one row per location)
CREATE TABLE company_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID NOT NULL UNIQUE REFERENCES locations(id) ON DELETE CASCADE,
  logo_url TEXT,               -- URL to logo (transparent PNG/SVG)
  favicon_url TEXT,            -- URL to favicon (PNG/ICO)
  company_name TEXT,           -- Display name override
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  updated_by UUID REFERENCES profiles(id)
);

CREATE INDEX idx_company_settings_location ON company_settings (location_id);

-- RLS
ALTER TABLE company_settings ENABLE ROW LEVEL SECURITY;

-- All authenticated users can read (needed for sidebar logo + favicon)
CREATE POLICY "Authenticated users can read company settings"
  ON company_settings FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- Only owners can update
CREATE POLICY "Owners can manage company settings"
  ON company_settings FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role = 'owner'
    )
  );

-- ============================================================
-- Supabase Storage bucket for branding assets
-- Run this in the SQL editor — creates the bucket if it doesn't exist
-- ============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'branding',
  'branding',
  TRUE,
  5242880,  -- 5MB limit
  ARRAY['image/png', 'image/svg+xml', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;

-- Allow anyone to read branding images (public bucket)
CREATE POLICY "Public read access for branding"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'branding');

-- Only owners can upload/update branding images
CREATE POLICY "Owners can upload branding"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'branding'
    AND EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role = 'owner'
    )
  );

CREATE POLICY "Owners can update branding"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'branding'
    AND EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role = 'owner'
    )
  );

CREATE POLICY "Owners can delete branding"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'branding'
    AND EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role = 'owner'
    )
  );
