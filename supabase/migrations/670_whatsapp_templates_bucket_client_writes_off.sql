-- 670 — WATPLBUCKET.1: no client session writes the public
-- 'whatsapp-templates' storage bucket, and the bucket only accepts the file
-- types and sizes a WhatsApp template header can use.
--
-- NOT APPLIED YET when this file was written. "VERIFIED LIVE" below is the
-- state of prod BEFORE this file runs (read-only, Supabase MCP, 30 Sep 2026).
-- Behaviour is proven ahead of apply by a PGlite replay
-- (tests/migration-670-whatsapp-templates-bucket-client-writes-off.test.js).
--
-- ===========================================================================
-- THE FINDING (follow-ups C90, found planning C89 WATPLCLIENTWRITE.1)
-- ===========================================================================
-- Mig 045 created the bucket PUBLIC with no file_size_limit and no
-- allowed_mime_types, and two storage.objects policies scoped only by bucket:
--   wa_templates_storage_insert  FOR INSERT TO authenticated
--                                WITH CHECK (bucket_id = 'whatsapp-templates')
--   wa_templates_storage_delete  FOR DELETE TO authenticated
--                                USING (bucket_id = 'whatsapp-templates')
-- So ANY signed-in account (staff, host, a member-app customer) could upload
-- any file of any type and size into a PUBLIC bucket: free hosting of
-- arbitrary content under this project's storage domain. No permissive
-- SELECT or UPDATE policy admits the bucket, so an existing object can be
-- neither overwritten (upsert needs SELECT + UPDATE) nor, through the
-- Storage API, deleted (Postgres applies SELECT policies to a DELETE that
-- filters on the row). The template rows themselves are closed by mig 669.
--
-- VERIFIED LIVE (30 Sep, BEFORE this migration):
--   storage.buckets 'whatsapp-templates': public true, file_size_limit NULL,
--   allowed_mime_types NULL. The two policies above, verbatim. 5 objects
--   (3 video/mp4, largest 13 MB; 2 image/png), every one at a server-minted
--   path, none with an owner (none uploaded by a session). 2 template
--   header_media_url values and 1 location card set point into the bucket:
--   Meta fetches them at send time, so the bucket STAYS PUBLIC.
--   Edge logs, two 24 h windows: 0 requests of any kind on the bucket.
--
-- WHO WRITES THE BUCKET (origin/main 5ed4b3d6; mobile, shared, champ-app,
-- champ-bridge, un1t-platform, un1t-sentinel, un1t-pi, un1t-finance-agent):
--   /api/whatsapp/templates/upload-media/sign  service role: validates the
--     file (src/lib/template-media.js) and mints createSignedUploadUrl.
--   WATemplateEditor.jsx, WhatsAppIntegrationTab.jsx (CardImageField)
--     browser: uploadToSignedUrl(path, token, file). Authorised by the
--     TOKEN, not by RLS: the Storage API verifies the token and runs the
--     upload as superuser (storage src/http/routes/object/uploadSignedObject
--     .ts: asSuperUser()), so neither policy is involved.
--   /api/whatsapp/templates/upload-media  service role: download, and
--     remove() when the real size or type fails validation.
--   Nothing else, ever (git history: the first upload path, cebbddf8, was a
--   service-role route; the signed-token flow replaced it in d91cb490).
--
-- ===========================================================================
-- THE FIX
-- ===========================================================================
--   DROP both policies (and mig 183's never-applied fte-expense-receipts
--   policy, see below). No replacement: service_role bypasses RLS and the
--   signed upload runs as superuser, so a "TO service_role" policy would
--   be dead text.
--   file_size_limit = 100 MiB (DOCUMENT, the largest cap in
--   TEMPLATE_MEDIA_LIMITS; images 5 MB and videos 16 MB stay enforced by
--   the sign and finalise routes). allowed_mime_types = the union of
--   TEMPLATE_MEDIA_LIMITS' mimes. The Storage API applies both to the
--   signed upload too, against the contentType the browser sends, which
--   the sign route has already checked against the same list.
--   public stays true (Meta fetches header media by URL).
--   Every other storage.objects policy is untouched (the self-check
--   compares them before and after).
--
-- PRIVILEGE: postgres does not own storage.objects (supabase_storage_admin
-- does). It may still create/alter/drop policies on it through supautils
-- (supautils.policy_grants lists storage.objects for postgres, verified
-- live), which is how migs 045, 403 and the branding fixes were applied. It
-- UPDATEs storage.buckets through its table grant (BYPASSRLS; mig 252).
--
-- Guard: tests/whatsapp-templates-bucket-guard.test.js.
--
-- APPLY: after this PR merges, same day, after the log check in
-- docs/superpowers/plans/2026-09-27-followups/C90-WATPLBUCKET.1.md
-- (Task 5, which also holds the pre/post probes and the rollback).
-- ===========================================================================

BEGIN;

-- DROP POLICY takes ACCESS EXCLUSIVE on storage.objects, which every
-- Storage API call reads (branding images on every landing page view).
-- Abort after 5 s rather than queue them behind this file; re-run later.
SET LOCAL lock_timeout = '5s';

-- Every OTHER storage.objects policy as it stands, so the self-check can
-- prove this file changed nothing else.
CREATE TEMP TABLE mig670_other_policies ON COMMIT DROP AS
  SELECT policyname::text AS policyname, permissive, cmd, roles::text AS roles, qual, with_check
    FROM pg_policies
   WHERE schemaname = 'storage' AND tablename = 'objects'
     AND policyname NOT IN ('wa_templates_storage_insert', 'wa_templates_storage_delete',
                            'fte_expense_receipts_deny_all');

DROP POLICY IF EXISTS wa_templates_storage_insert ON storage.objects;
DROP POLICY IF EXISTS wa_templates_storage_delete ON storage.objects;

-- Mig 183's FILE creates fte_expense_receipts_deny_all, a PERMISSIVE
-- FOR ALL TO authenticated policy USING/WITH CHECK (bucket_id <>
-- 'fte-expense-receipts'): it admits every other bucket, this one included
-- (the mig 403 defect class). Prod never ran it (absent from pg_policies and
-- from the statements recorded for 183, verified 30 Sep), so this is a no-op
-- there; it closes the same hole in any database built from the files.
DROP POLICY IF EXISTS fte_expense_receipts_deny_all ON storage.objects;

UPDATE storage.buckets
   SET public = true,
       file_size_limit = 104857600,  -- 100 MiB
       allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'video/mp4', 'video/3gpp', 'application/pdf']
 WHERE id = 'whatsapp-templates';

-- ---------------------------------------------------------------------------
-- Self-check: the catalog, never this file's text (mig 153's lesson). Any
-- failure raises and the whole file rolls back.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_expected_mimes text[] := ARRAY['application/pdf', 'image/jpeg', 'image/png', 'video/3gpp', 'video/mp4'];
  v_bucket record;
  v_n int;
  v_bad text;
BEGIN
  -- 1. The bucket: exactly one row, still public, the limits set.
  SELECT count(*) INTO v_n FROM storage.buckets WHERE id = 'whatsapp-templates';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'mig 670: bucket whatsapp-templates is missing';
  END IF;
  SELECT public, file_size_limit, allowed_mime_types INTO v_bucket
    FROM storage.buckets WHERE id = 'whatsapp-templates';
  IF v_bucket.public IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'mig 670: bucket whatsapp-templates must stay public (Meta fetches header media by URL)';
  END IF;
  IF v_bucket.file_size_limit IS DISTINCT FROM 104857600 THEN
    RAISE EXCEPTION 'mig 670: bucket whatsapp-templates file_size_limit is %, expected 104857600', v_bucket.file_size_limit;
  END IF;
  IF v_bucket.allowed_mime_types IS NULL
     OR (SELECT array_agg(DISTINCT m ORDER BY m) FROM unnest(v_bucket.allowed_mime_types) m) <> v_expected_mimes THEN
    RAISE EXCEPTION 'mig 670: bucket whatsapp-templates allowed_mime_types is %, expected %',
      v_bucket.allowed_mime_types, v_expected_mimes;
  END IF;

  -- 2. The dropped policies are gone.
  SELECT string_agg(policyname, ', ' ORDER BY policyname) INTO v_bad
    FROM pg_policies
   WHERE schemaname = 'storage' AND tablename = 'objects'
     AND policyname IN ('wa_templates_storage_insert', 'wa_templates_storage_delete',
                        'fte_expense_receipts_deny_all');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'mig 670: policies still on storage.objects: %', v_bad;
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
     AND (coalesce(qual, '') || ' ' || coalesce(with_check, '') LIKE '%whatsapp-templates%'
          OR coalesce(qual, '') || ' ' || coalesce(with_check, '') !~ 'bucket_id\s*=\s*''[^'']+''');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'mig 670: client policies on storage.objects admit the whatsapp-templates bucket: %', v_bad;
  END IF;

  -- 4. Every other storage.objects policy is exactly as it was.
  SELECT string_agg(policyname, ', ' ORDER BY policyname) INTO v_bad FROM (
    (SELECT * FROM mig670_other_policies
      EXCEPT
     SELECT policyname::text, permissive, cmd, roles::text, qual, with_check
       FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects')
    UNION
    (SELECT policyname::text, permissive, cmd, roles::text, qual, with_check
       FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
      EXCEPT
     SELECT * FROM mig670_other_policies)
  ) d;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'mig 670: other storage.objects policies changed: %', v_bad;
  END IF;

  -- 5. RLS is still on (the policies mean nothing without it).
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'storage.objects'::regclass) THEN
    RAISE EXCEPTION 'mig 670: row level security is off on storage.objects';
  END IF;

  RAISE NOTICE 'mig 670: whatsapp-templates is public for reads, writable only by service_role and signed-upload tokens, and capped at 100 MiB of template media types.';
END $$;

COMMIT;
