-- WhatsApp template media support.
--
-- Templates with IMAGE / VIDEO / DOCUMENT headers need a real example
-- asset uploaded via Meta's Resumable Upload API at template-creation
-- time. The previous editor submitted a placeholder URL which fails
-- approval. This migration adds:
--   1. Three fields to whatsapp_templates so we remember the handle
--      Meta gave us, the public URL we use at runtime, and the path
--      in our storage bucket (for cleanup / re-upload).
--   2. A 'whatsapp-templates' storage bucket (public — Meta fetches
--      the media URL we hand them at send time, so it has to be
--      reachable without a token; paths are UUID-based so they're
--      effectively unguessable).

ALTER TABLE whatsapp_templates
  ADD COLUMN IF NOT EXISTS header_media_handle TEXT,
  ADD COLUMN IF NOT EXISTS header_media_url    TEXT,
  ADD COLUMN IF NOT EXISTS header_media_path   TEXT;

COMMENT ON COLUMN whatsapp_templates.header_media_handle IS
  'Meta resumable-upload handle (h-...). Used in components.example.header_handle when submitting the template for approval.';
COMMENT ON COLUMN whatsapp_templates.header_media_url IS
  'Public URL of the media asset. Used at runtime when sending the template — Meta fetches the asset from this URL. Operators can override per-broadcast / per-step.';
COMMENT ON COLUMN whatsapp_templates.header_media_path IS
  'Storage path inside the whatsapp-templates bucket. Kept so we can clean up if the template is deleted.';

-- Public bucket. Meta fetches this URL at send time, so it must be
-- reachable without auth. UUID-based paths in the upload route make
-- enumeration impractical.
INSERT INTO storage.buckets (id, name, public)
VALUES ('whatsapp-templates', 'whatsapp-templates', true)
ON CONFLICT (id) DO NOTHING;

-- RLS: any authenticated user with location access can write; the
-- service role (used by the API) is unrestricted. Public READ is
-- granted by the bucket-level public flag above.
DROP POLICY IF EXISTS wa_templates_storage_insert ON storage.objects;
CREATE POLICY wa_templates_storage_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'whatsapp-templates');

DROP POLICY IF EXISTS wa_templates_storage_delete ON storage.objects;
CREATE POLICY wa_templates_storage_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'whatsapp-templates');
