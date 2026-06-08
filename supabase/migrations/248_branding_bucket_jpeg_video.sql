-- 248 — widen the 'branding' bucket for landing-page media uploads.
--
-- The bucket previously allowed only png/webp/svg/ico at a 5MB limit,
-- which (a) silently rejected JPEG hero/background images (the client
-- compressor re-encodes photos to JPEG), and (b) left no room for a
-- hero background video.
--
-- Adds image/jpeg + video/mp4 + video/webm and raises the per-object
-- size limit to 26MB (covers the 25MB hero-video cap + overhead). Video
-- is uploaded browser-direct via a signed URL
-- (/api/landing-page-settings/media/signed-upload) to bypass Vercel's
-- ~4.5MB serverless request-body cap; the bucket limits below are the
-- real ceiling on that direct upload.
--
-- Already applied to the live project via the Supabase MCP at deploy
-- time; this file is the tracked record. Idempotent — re-running sets
-- the same target config.

update storage.buckets
set allowed_mime_types = array[
      'image/png','image/jpeg','image/webp','image/svg+xml',
      'image/x-icon','image/vnd.microsoft.icon',
      'video/mp4','video/webm'
    ],
    file_size_limit = 27262976  -- 26 MB
where id = 'branding';
