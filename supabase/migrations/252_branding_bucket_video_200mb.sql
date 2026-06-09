-- 252 — raise the 'branding' bucket to 200MB and accept .mov, for tap-to-play
-- landing-page testimonial videos.
--
-- Context: testimonial clips show a poster image until a visitor taps them, so
-- the video only downloads on tap and first paint is unaffected by clip size.
-- In-browser compression (src/lib/video-compress.js) shrinks clips to ~720p
-- when it can run, but it can't always (older Safari, low device memory), and a
-- hard-reject on the un-compressed size blocked operators with large source
-- clips (e.g. a 65MB phone recording). Two changes let the clip upload anyway:
--
--   1. file_size_limit 50MB → 200MB. The app layer (landing-media-upload.js
--      videoOutputCap) still holds AUTOPLAY hero backgrounds to 50MB because
--      those download on every page view; only tap-to-play testimonials use the
--      full 200MB ceiling.
--   2. + video/quicktime in allowed_mime_types. The client normally transcodes
--      .mov → mp4 before upload, but when compression can't run the original
--      .mov must be storable rather than rejected at the bucket.
--
-- Already applied to the live project via the Supabase MCP at deploy time; this
-- file is the tracked record. Idempotent — re-running sets the same config.

update storage.buckets
set allowed_mime_types = array[
      'image/png','image/jpeg','image/webp','image/svg+xml',
      'image/x-icon','image/vnd.microsoft.icon',
      'video/mp4','video/webm','video/quicktime'
    ],
    file_size_limit = 209715200  -- 200 MB
where id = 'branding';
