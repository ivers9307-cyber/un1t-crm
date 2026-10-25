-- 671 — TVBUCKET.1: no client session writes the public 'tv-content'
-- storage bucket, and the bucket only accepts the image types and size the
-- TV upload route accepts.
--
-- NOT APPLIED YET when this file was written. "VERIFIED LIVE" below is the
-- state of prod BEFORE this file runs (read-only, Supabase MCP, 30 Sep 2026).
-- Behaviour is proven ahead of apply by a PGlite replay
-- (tests/migration-671-tv-content-bucket-client-writes-off.test.js).
--
-- ===========================================================================
-- THE FINDING (follow-ups C92, found planning C90 WATPLBUCKET.1)
-- ===========================================================================
-- Mig 160 created the bucket PUBLIC with no file_size_limit and no
-- allowed_mime_types, and two storage.objects policies scoped only by bucket:
--   tv_content_storage_write   FOR INSERT TO authenticated
--                              WITH CHECK (bucket_id = 'tv-content')
--   tv_content_storage_delete  FOR DELETE TO authenticated
--                              USING (bucket_id = 'tv-content')
-- So ANY signed-in account (staff, host, a member-app customer) could upload
-- any file of any type and size into a PUBLIC bucket: free hosting of
-- arbitrary content under this project's storage domain. The Storage API's
-- plain (non-upsert) upload is a RETURNING-less INSERT, so the INSERT policy
-- alone admits it. No permissive SELECT or UPDATE policy admits the bucket,
-- so an existing object can be neither overwritten (upsert needs SELECT +
-- UPDATE), deleted (the Storage API's DELETE … RETURNING needs a SELECT
-- policy to see the row) nor listed. This is mig 670's hole on a second
-- bucket.
--
-- VERIFIED LIVE (30 Sep, BEFORE this migration):
--   storage.buckets 'tv-content': public true, file_size_limit NULL,
--   allowed_mime_types NULL. The two policies above, verbatim. 22 objects
--   (13 image/jpeg, largest 1.4 MB; 9 image/png, largest 2.9 MB), every one
--   at a path the upload route mints, none with an owner (none uploaded by
--   a session). 1 template base image points into it; TV cast pages, the
--   Pi kiosks and the phone read it by PUBLIC URL with no auth, so the
--   bucket STAYS PUBLIC. Edge logs, two 24 h windows: 0 requests of any
--   kind on the bucket.
--
-- WHO WRITES THE BUCKET (origin/main 4aa6df68; mobile, shared, desktop,
-- supabase/functions, champ-app, champ-bridge, un1t-platform,
-- un1t-sentinel, un1t-pi, un1t-finance-agent):
--   /api/admin/tv-displays/upload  service role: checks the tv_displays
--     permission at the location, validates the file against
--     src/lib/tv-media.js, uploads (upsert false). Called by TVAdmin.jsx
--     (push image), TemplateEditor.jsx (template base image) and the
--     phone's uploadTvImage (mobile/lib/tv-api.js). Nothing else, ever: the
--     only client upload (mig 160's browser db.storage.upload) was replaced
--     by this route in c944c9aa (20 May), and nothing removes objects.
--
-- ===========================================================================
-- THE FIX
-- ===========================================================================
--   DROP both policies. No replacement: service_role bypasses RLS, so a
--   "TO service_role" policy would be dead text.
--   file_size_limit = 15 MiB and allowed_mime_types = the five image types,
--   both exactly src/lib/tv-media.js (the route's own check). The Storage
--   API applies both to the service-role upload too, against the
--   contentType the route sends (file.type, already checked).
--   public stays true.
--   Every other storage.objects policy is untouched (the self-check
--   compares them before and after).
--
-- PRIVILEGE: postgres does not own storage.objects (supabase_storage_admin
-- does). It may still create/alter/drop policies on it through supautils
-- (supautils.policy_grants lists storage.objects for postgres, verified
-- live), which is how migs 045, 403 and 670 were applied. It UPDATEs
-- storage.buckets through its table grant (BYPASSRLS; migs 252, 670).
--
-- Guard: tests/tv-content-bucket-guard.test.js.
--
-- APPLY: after this PR merges, same day, after the log check in
-- docs/superpowers/plans/2026-09-27-followups/C92-TVBUCKET.1.md
-- (Task 6, which also holds the pre/post probes and the rollback).
-- ===========================================================================

BEGIN;

-- DROP POLICY takes ACCESS EXCLUSIVE on storage.objects, which every
-- Storage API call reads (branding images on every landing page view).
-- Abort after 5 s rather than queue them behind this file; re-run later.
SET LOCAL lock_timeout = '5s';

-- Every OTHER storage.objects policy as it stands, so the self-check can
-- prove this file changed nothing else.
CREATE TEMP TABLE mig671_other_policies ON COMMIT DROP AS
  SELECT policyname::text AS policyname, permissive, cmd, roles::text AS roles, qual, with_check
    FROM pg_policies
   WHERE schemaname = 'storage' AND tablename = 'objects'
     AND policyname NOT IN ('tv_content_storage_write', 'tv_content_storage_delete');

DROP POLICY IF EXISTS tv_content_storage_write ON storage.objects;
DROP POLICY IF EXISTS tv_content_storage_delete ON storage.objects;

UPDATE storage.buckets
   SET public = true,
       file_size_limit = 15728640,  -- 15 MiB
       allowed_mime_types = ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']
 WHERE id = 'tv-content';

-- ---------------------------------------------------------------------------
-- Self-check: the catalog, never this file's text (mig 153's lesson). Any
-- failure raises and the whole file rolls back.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_expected_mimes text[] := ARRAY['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp'];
  v_bucket record;
  v_n int;
  v_bad text;
BEGIN
  -- 1. The bucket: exactly one row, still public, the limits set.
  SELECT count(*) INTO v_n FROM storage.buckets WHERE id = 'tv-content';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'mig 671: bucket tv-content is missing';
  END IF;
  SELECT public, file_size_limit, allowed_mime_types INTO v_bucket
    FROM storage.buckets WHERE id = 'tv-content';
  IF v_bucket.public IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'mig 671: bucket tv-content must stay public (TVs and the phone load images by URL)';
  END IF;
  IF v_bucket.file_size_limit IS DISTINCT FROM 15728640 THEN
    RAISE EXCEPTION 'mig 671: bucket tv-content file_size_limit is %, expected 15728640', v_bucket.file_size_limit;
  END IF;
  IF v_bucket.allowed_mime_types IS NULL
     OR (SELECT array_agg(DISTINCT m ORDER BY m) FROM unnest(v_bucket.allowed_mime_types) m) <> v_expected_mimes THEN
    RAISE EXCEPTION 'mig 671: bucket tv-content allowed_mime_types is %, expected %',
      v_bucket.allowed_mime_types, v_expected_mimes;
  END IF;

  -- 2. The dropped policies are gone.
  SELECT string_agg(policyname, ', ' ORDER BY policyname) INTO v_bad
    FROM pg_policies
   WHERE schemaname = 'storage' AND tablename = 'objects'
     AND policyname IN ('tv_content_storage_write', 'tv_content_storage_delete');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'mig 671: policies still on storage.objects: %', v_bad;
  END IF;

  -- 3. No PERMISSIVE policy of ANY command that reaches a client role admits
  --    this bucket: it names the bucket, or it has no positive
  --    `bucket_id = '<literal>'` restriction at all (so it admits every
  --    bucket). SELECT counts too: a client SELECT would list the bucket's
  --    object names, which are what keep its public URLs unguessable.
  --    A floor, not a proof: `bucket_id = 'x' OR true` passes this text test.
  SELECT string_agg(policyname || ' ' || cmd, ', ' ORDER BY policyname) INTO v_bad
    FROM pg_policies
   WHERE schemaname = 'storage' AND tablename = 'objects'
     AND permissive = 'PERMISSIVE'
     AND roles && ARRAY['anon', 'authenticated', 'public']::name[]
     AND (coalesce(qual, '') || ' ' || coalesce(with_check, '') LIKE '%tv-content%'
          OR coalesce(qual, '') || ' ' || coalesce(with_check, '') !~ 'bucket_id\s*=\s*''[^'']+''');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'mig 671: client policies on storage.objects admit the tv-content bucket: %', v_bad;
  END IF;

  -- 4. Every other storage.objects policy is exactly as it was.
  SELECT string_agg(policyname, ', ' ORDER BY policyname) INTO v_bad FROM (
    (SELECT * FROM mig671_other_policies
      EXCEPT
     SELECT policyname::text, permissive, cmd, roles::text, qual, with_check
       FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects')
    UNION
    (SELECT policyname::text, permissive, cmd, roles::text, qual, with_check
       FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
      EXCEPT
     SELECT * FROM mig671_other_policies)
  ) d;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'mig 671: other storage.objects policies changed: %', v_bad;
  END IF;

  -- 5. RLS is still on (the policies mean nothing without it).
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'storage.objects'::regclass) THEN
    RAISE EXCEPTION 'mig 671: row level security is off on storage.objects';
  END IF;

  RAISE NOTICE 'mig 671: tv-content is public for reads, writable only by service_role, and capped at 15 MiB of PNG/JPEG/WebP/GIF/AVIF.';
END $$;

COMMIT;
