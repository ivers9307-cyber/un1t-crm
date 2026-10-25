-- 687 — CARDOCBUCKET.1: the private 'car-documents' storage bucket gets the
-- size and type limits its writers use. Nothing is deleted.
--
-- NOT APPLIED YET when this file was written. "VERIFIED LIVE" below is the
-- state of prod BEFORE this file runs (read-only, Supabase MCP, 30 Sep 2026).
-- Behaviour is proven ahead of apply by a PGlite replay
-- (tests/migration-687-car-documents-bucket-limits.test.js).
--
-- ===========================================================================
-- THE FINDING (follow-ups C102, found planning C94 CARSCLIENTWRITE.1, F3)
-- ===========================================================================
-- The bucket was created by mig 025 with no file_size_limit and no
-- allowed_mime_types, so Storage accepted any file of any size the
-- service-role writers sent it, and the upload route checked only size.
--
-- VERIFIED LIVE (30 Sep, BEFORE this migration):
--   storage.buckets 'car-documents': public false, file_size_limit NULL,
--   allowed_mime_types NULL. 15 objects, none with an owner (none uploaded by
--   a session): 13 application/pdf, 2 image/jpeg; largest 362,157 bytes.
--   Every object is referenced: 12 by car_documents.storage_path and 3 (the
--   saved Xero sales-invoice PDFs under cars/) by cars.xero_invoice_pdf_path.
--   0 unreferenced. The only storage.objects policy naming the bucket is mig
--   403's RESTRICTIVE "private buckets deny client" (FOR ALL TO anon,
--   authenticated): no client reads or writes it.
--
-- WHO WRITES THE BUCKET (origin/main 32cd8033): service role only.
--   POST /api/cars/[id]/documents (the web DocumentsCard upload), which
--   after CARDOCBUCKET.1 validates against src/lib/car-document-media.js;
--   src/lib/xero/invoices.js uploadInvoicePdf (application/pdf).
--
-- ===========================================================================
-- THE FIX
-- ===========================================================================
--   file_size_limit = 25 MiB and allowed_mime_types = the seven types in
--   src/lib/car-document-media.js (the route's constants; the Xero PDF is
--   one of them). The bucket stays private; no object, no other bucket and
--   no storage.objects policy is touched (the self-check compares all three
--   before and after). DECIDED (Richard, 30 Sep): keep every object.
--
-- PRIVILEGE: postgres UPDATEs storage.buckets through its table grant
-- (BYPASSRLS), as migs 252, 670, 671 and 675 did.
--
-- Guard: tests/car-documents-bucket-guard.test.js.
--
-- APPLY: after this PR merges, per
-- docs/superpowers/plans/2026-09-27-followups/C102-CARDOCBUCKET.1.md
-- (Task 7: pre/post probes and the rollback record).
-- ===========================================================================

BEGIN;

-- The UPDATE row-locks the bucket row every Storage call on the bucket
-- reads. Abort after 5 s rather than queue them behind this file.
SET LOCAL lock_timeout = '5s';

-- What must not change, captured first.
CREATE TEMP TABLE mig687_objects ON COMMIT DROP AS
  SELECT count(*)::int AS n FROM storage.objects WHERE bucket_id = 'car-documents';
CREATE TEMP TABLE mig687_other_buckets ON COMMIT DROP AS
  SELECT id, public, file_size_limit, allowed_mime_types FROM storage.buckets WHERE id <> 'car-documents';
CREATE TEMP TABLE mig687_policies ON COMMIT DROP AS
  SELECT policyname::text AS policyname, permissive, cmd, roles::text AS roles, qual, with_check
    FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects';

UPDATE storage.buckets
   SET file_size_limit = 26214400,  -- 25 MiB
       allowed_mime_types = ARRAY['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp',
                                  'image/heic', 'image/heif']
 WHERE id = 'car-documents';

-- ---------------------------------------------------------------------------
-- Self-check: the catalog, never this file's text (mig 153's lesson). Any
-- failure raises and the whole file rolls back.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_expected_mimes text[] := ARRAY['application/pdf', 'image/gif', 'image/heic', 'image/heif',
                                   'image/jpeg', 'image/png', 'image/webp'];
  v_bucket record;
  v_n int;
  v_before int;
  v_bad text;
BEGIN
  -- 1. The bucket: exactly one row, still private, the limits set.
  SELECT count(*) INTO v_n FROM storage.buckets WHERE id = 'car-documents';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'mig 687: bucket car-documents is missing';
  END IF;
  SELECT public, file_size_limit, allowed_mime_types INTO v_bucket
    FROM storage.buckets WHERE id = 'car-documents';
  IF v_bucket.public IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'mig 687: bucket car-documents must stay private (buyer and supplier invoices)';
  END IF;
  IF v_bucket.file_size_limit IS DISTINCT FROM 26214400 THEN
    RAISE EXCEPTION 'mig 687: bucket car-documents file_size_limit is %, expected 26214400', v_bucket.file_size_limit;
  END IF;
  IF v_bucket.allowed_mime_types IS NULL
     OR (SELECT array_agg(DISTINCT m ORDER BY m) FROM unnest(v_bucket.allowed_mime_types) m) <> v_expected_mimes
     OR cardinality(v_bucket.allowed_mime_types) <> cardinality(v_expected_mimes) THEN
    RAISE EXCEPTION 'mig 687: bucket car-documents allowed_mime_types is %, expected %',
      v_bucket.allowed_mime_types, v_expected_mimes;
  END IF;

  -- 2. Every object is still there (Richard: keep them all).
  SELECT n INTO v_before FROM mig687_objects;
  SELECT count(*) INTO v_n FROM storage.objects WHERE bucket_id = 'car-documents';
  IF v_n <> v_before THEN
    RAISE EXCEPTION 'mig 687: the bucket held % objects and now holds %', v_before, v_n;
  END IF;

  -- 3. Every other bucket is exactly as it was.
  SELECT string_agg(id, ', ' ORDER BY id) INTO v_bad FROM (
    (SELECT * FROM mig687_other_buckets
      EXCEPT SELECT id, public, file_size_limit, allowed_mime_types FROM storage.buckets WHERE id <> 'car-documents')
    UNION
    (SELECT id, public, file_size_limit, allowed_mime_types FROM storage.buckets WHERE id <> 'car-documents'
      EXCEPT SELECT * FROM mig687_other_buckets)
  ) d;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'mig 687: other buckets changed: %', v_bad;
  END IF;

  -- 4. Every storage.objects policy is exactly as it was ...
  SELECT string_agg(policyname, ', ' ORDER BY policyname) INTO v_bad FROM (
    (SELECT * FROM mig687_policies
      EXCEPT SELECT policyname::text, permissive, cmd, roles::text, qual, with_check
               FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects')
    UNION
    (SELECT policyname::text, permissive, cmd, roles::text, qual, with_check
       FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
      EXCEPT SELECT * FROM mig687_policies)
  ) d;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'mig 687: storage.objects policies changed: %', v_bad;
  END IF;

  -- 5. ... and mig 403's restrictive deny still covers this bucket.
  IF NOT EXISTS (
       SELECT 1 FROM pg_policies
        WHERE schemaname = 'storage' AND tablename = 'objects'
          AND policyname = 'private buckets deny client' AND permissive = 'RESTRICTIVE' AND cmd = 'ALL'
          AND roles::text = '{anon,authenticated}'
          AND qual LIKE '%''car-documents''%' AND with_check LIKE '%''car-documents''%') THEN
    RAISE EXCEPTION 'mig 687: the restrictive "private buckets deny client" policy no longer covers car-documents';
  END IF;

  RAISE NOTICE 'mig 687: car-documents is private, 25 MiB, seven types; % objects kept; nothing else changed.', v_n;
END $$;

COMMIT;
