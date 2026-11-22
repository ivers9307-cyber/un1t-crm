-- ===========================================================================
-- GIFLIB.1 (mig 869): the public 'branding' bucket accepts image/gif.
--
-- WHY: the email tools place only images from a studio's library
-- (landing-page/<location_id>/ in this bucket), and an animated email header
-- is a GIF: the one animated format every inbox shows. The bucket's
-- allowed_mime_types (mig 252, re-asserted by mig 675) had no image/gif, so
-- Storage refused one whatever the upload route said.
--
-- WHAT: allowed_mime_types gains 'image/gif'. Nothing else changes: the
-- bucket stays public, the 200 MiB limit stays, and no policy is touched (the
-- bucket is still written only by service-role routes and signed uploads).
-- The list is src/lib/branding-media.js, and
-- tests/branding-bucket-guard.test.js keeps the two in step.
--
-- APPLY: before the code deploys (the upload route accepts GIFs once it
-- does). Safe to apply early: widening the list refuses nothing.
-- ===========================================================================

BEGIN;

UPDATE storage.buckets
   SET public = true,
       file_size_limit = 209715200,  -- 200 MiB
       allowed_mime_types = ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml',
                                  'image/x-icon', 'image/vnd.microsoft.icon',
                                  'video/mp4', 'video/webm', 'video/quicktime']
 WHERE id = 'branding';

-- Self-check: the catalog, never this file's text. A failure rolls back.
DO $$
DECLARE
  v_expected_mimes text[] := ARRAY['image/gif', 'image/jpeg', 'image/png', 'image/svg+xml',
                                   'image/vnd.microsoft.icon', 'image/webp', 'image/x-icon',
                                   'video/mp4', 'video/quicktime', 'video/webm'];
  v_bucket record;
  v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM storage.buckets WHERE id = 'branding';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'mig 869: bucket branding is missing';
  END IF;
  SELECT public, file_size_limit, allowed_mime_types INTO v_bucket
    FROM storage.buckets WHERE id = 'branding';
  IF v_bucket.public IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'mig 869: bucket branding must stay public (pages, emails and favicons load it by URL)';
  END IF;
  IF v_bucket.file_size_limit IS DISTINCT FROM 209715200 THEN
    RAISE EXCEPTION 'mig 869: bucket branding file_size_limit is %, expected 209715200', v_bucket.file_size_limit;
  END IF;
  IF v_bucket.allowed_mime_types IS NULL
     OR (SELECT array_agg(DISTINCT m ORDER BY m) FROM unnest(v_bucket.allowed_mime_types) m) <> v_expected_mimes THEN
    RAISE EXCEPTION 'mig 869: bucket branding allowed_mime_types is %, expected %',
      v_bucket.allowed_mime_types, v_expected_mimes;
  END IF;
END $$;

COMMIT;
