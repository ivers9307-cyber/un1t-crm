-- 250 — raise the 'branding' bucket size limit for compressed landing-page
-- video uploads. Videos are now transcoded to ~720p MP4 in the browser
-- before upload (src/lib/video-compress.js), so the stored output is small;
-- 50MB is generous headroom for the compressed output + slightly-larger
-- passthrough clips. allowed_mime_types unchanged (mig 248: + mp4 + webm).
update storage.buckets
set file_size_limit = 52428800  -- 50 MB
where id = 'branding';
