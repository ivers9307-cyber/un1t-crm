-- 675 — BRANDINGBUCKET.1: no client session writes the public 'branding'
-- storage bucket. Every writer is a service-role route (or a token it mints),
-- each gated on the studio or event the file belongs to; the bucket keeps its
-- limits.
--
-- NOT APPLIED YET when this file was written. "VERIFIED LIVE" below is the
-- state of prod BEFORE this file runs (read-only, Supabase MCP, 30 Sep 2026).
-- Behaviour is proven ahead of apply by a PGlite replay
-- (tests/migration-675-branding-bucket-client-writes-off.test.js).
--
-- ===========================================================================
-- THE FINDING (follow-ups C100, found planning C94 CARSCLIENTWRITE.1)
-- ===========================================================================
-- Mig 013 created three storage.objects policies on the bucket; prod has
-- since had them redefined out of band (mig 549's notes) to:
--   "Owners can upload branding"  FOR INSERT TO authenticated
--      WITH CHECK ((bucket_id = 'branding') AND private.is_owner())
--   "Owners can update branding"  FOR UPDATE TO authenticated
--      USING ((bucket_id = 'branding') AND private.is_owner())
--   "Owners can delete branding"  FOR DELETE TO authenticated
--      USING ((bucket_id = 'branding') AND private.is_owner())
-- private.is_owner() is profiles.role IN ('owner', 'master') on an active,
-- untombstoned profile: the highest role ANYWHERE, with no location and no
-- path. So an owner at one studio could, from their own session and without
-- any CRM route, upload into any other studio's or organisation's area of a
-- PUBLIC bucket (logos, landing-page and event media, signature photos), any
-- of its nine types up to 200 MiB, skipping every route's per-studio gate,
-- size cap, magic-byte sniff and SVG structure check.
-- No SELECT policy admits the bucket (mig 022 dropped mig 013's public read),
-- so a session could not overwrite (the Storage upsert is INSERT … ON
-- CONFLICT DO UPDATE, which needs SELECT on the existing row), delete,
-- move, copy or list. The UPDATE and DELETE policies were latent: one SELECT
-- policy on the bucket would have armed cross-tenant overwrite and delete.
--
-- VERIFIED LIVE (30 Sep, BEFORE this migration):
--   storage.buckets 'branding': public true, file_size_limit 209715200,
--   allowed_mime_types the nine types below (mig 252). The three policies
--   above, verbatim; no other policy names the bucket. private.is_owner()
--   admits 3 logins (2 owners, 1 master) and is called by these three
--   policies and nothing else. 59 objects (37 image/jpeg, 8 image/png,
--   4 image/webp, 10 video/mp4; largest 14.9 MB), none with an owner (none
--   uploaded by a session). Landing pages, event pages, customer emails,
--   favicons and email signatures load the bucket by PUBLIC URL, so it STAYS
--   PUBLIC. Edge logs, two 24 h windows: public GETs and renders with no JWT,
--   service_role uploads, lists and one delete; no request from an
--   authenticated or anon session.
--
-- WHO WRITES THE BUCKET (origin/main cccff46c; mobile, shared, desktop,
-- supabase/functions, champ-app, champ-bridge, un1t-platform,
-- un1t-sentinel, un1t-pi, un1t-finance-agent):
--   service role, each after its own gate and type/size check:
--   /api/settings/branding/upload, /api/landing-page-settings/{hero-image,
--   hero-video,gallery-photo,pillar-photo,media},
--   /api/chooser-settings/tile-image, /api/events/[id]/{hero,logo},
--   /api/host/events/[id]/hero, /api/me/signature-photo, and
--   /api/staff/[id]/permanent (removes a signature photo).
--   /api/landing-page-settings/media/signed-upload mints a signed upload URL
--   and the browser (src/lib/landing-media-upload.js) PUTs the video with
--   uploadToSignedUrl: authorised by the TOKEN, run by the Storage API as
--   superuser, so no policy is involved. Nothing else, ever (git history:
--   every writer since the first, 82a57620, is one of these routes).
--
-- ===========================================================================
-- THE FIX
-- ===========================================================================
--   DROP the three policies. No replacement: service_role bypasses RLS and
--   the signed upload runs as superuser, so a "TO service_role" policy would
--   be dead text. After this file private.is_owner() has no caller (left in
--   place; dropping it is a follow-up).
--   The bucket keeps public = true, file_size_limit = 200 MiB and its nine
--   types (src/lib/branding-media.js): the union of what the writer routes
--   accept, and the signed video upload's only ceiling. Re-set here so the
--   file records them; a no-op on prod.
--   Every other storage.objects policy is untouched (the self-check
--   compares them before and after).
--
-- PRIVILEGE: postgres does not own storage.objects (supabase_storage_admin
-- does). It may still drop policies on it through supautils
-- (supautils.policy_grants lists storage.objects for postgres, verified
-- live), which is how migs 045, 403, 670 and 671 were applied. It UPDATEs
-- storage.buckets through its table grant (BYPASSRLS; migs 252, 670, 671).
--
-- Guard: tests/branding-bucket-guard.test.js.
--
-- APPLY: after this PR merges, same day, after the log check in
-- docs/superpowers/plans/2026-09-27-followups/C100-BRANDINGBUCKET.1.md
-- (Task 6, which also holds the pre/post probes and the rollback).
-- ===========================================================================

BEGIN;

-- DROP POLICY takes ACCESS EXCLUSIVE on storage.objects, which every
-- Storage API call reads (branding images on every landing page view).
-- Abort after 5 s rather than queue them behind this file; re-run later.
SET LOCAL lock_timeout = '5s';

-- Every OTHER storage.objects policy as it stands, so the self-check can
-- prove this file changed nothing else.
CREATE TEMP TABLE mig675_other_policies ON COMMIT DROP AS
  SELECT policyname::text AS policyname, permissive, cmd, roles::text AS roles, qual, with_check
    FROM pg_policies
   WHERE schemaname = 'storage' AND tablename = 'objects'
     AND policyname NOT IN ('Owners can upload branding', 'Owners can update branding',
                            'Owners can delete branding');

DROP POLICY IF EXISTS "Owners can upload branding" ON storage.objects;
DROP POLICY IF EXISTS "Owners can update branding" ON storage.objects;
DROP POLICY IF EXISTS "Owners can delete branding" ON storage.objects;

UPDATE storage.buckets
   SET public = true,
       file_size_limit = 209715200,  -- 200 MiB
       allowed_mime_types = ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml',
                                  'image/x-icon', 'image/vnd.microsoft.icon',
                                  'video/mp4', 'video/webm', 'video/quicktime']
 WHERE id = 'branding';

-- ---------------------------------------------------------------------------
-- Self-check: the catalog, never this file's text (mig 153's lesson). Any
-- failure raises and the whole file rolls back.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_expected_mimes text[] := ARRAY['image/jpeg', 'image/png', 'image/svg+xml', 'image/vnd.microsoft.icon',
                                   'image/webp', 'image/x-icon', 'video/mp4', 'video/quicktime', 'video/webm'];
  v_bucket record;
  v_n int;
  v_bad text;
BEGIN
  -- 1. The bucket: exactly one row, still public, the limits set.
  SELECT count(*) INTO v_n FROM storage.buckets WHERE id = 'branding';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'mig 675: bucket branding is missing';
  END IF;
  SELECT public, file_size_limit, allowed_mime_types INTO v_bucket
    FROM storage.buckets WHERE id = 'branding';
  IF v_bucket.public IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'mig 675: bucket branding must stay public (pages, emails and favicons load it by URL)';
  END IF;
  IF v_bucket.file_size_limit IS DISTINCT FROM 209715200 THEN
    RAISE EXCEPTION 'mig 675: bucket branding file_size_limit is %, expected 209715200', v_bucket.file_size_limit;
  END IF;
  IF v_bucket.allowed_mime_types IS NULL
     OR (SELECT array_agg(DISTINCT m ORDER BY m) FROM unnest(v_bucket.allowed_mime_types) m) <> v_expected_mimes THEN
    RAISE EXCEPTION 'mig 675: bucket branding allowed_mime_types is %, expected %',
      v_bucket.allowed_mime_types, v_expected_mimes;
  END IF;

  -- 2. The dropped policies are gone.
  SELECT string_agg(policyname, ', ' ORDER BY policyname) INTO v_bad
    FROM pg_policies
   WHERE schemaname = 'storage' AND tablename = 'objects'
     AND policyname IN ('Owners can upload branding', 'Owners can update branding',
                        'Owners can delete branding');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'mig 675: policies still on storage.objects: %', v_bad;
  END IF;

  -- 3. No PERMISSIVE policy of ANY command that reaches a client role admits
  --    this bucket: it names the bucket, or it has no positive
  --    `bucket_id = '<literal>'` restriction at all (so it admits every
  --    bucket). SELECT counts too: it would list the bucket, and it is what
  --    arms an UPDATE or DELETE policy.
  --    A floor, not a proof: `bucket_id = 'x' OR true` passes this text test.
  SELECT string_agg(policyname || ' ' || cmd, ', ' ORDER BY policyname) INTO v_bad
    FROM pg_policies
   WHERE schemaname = 'storage' AND tablename = 'objects'
     AND permissive = 'PERMISSIVE'
     AND roles && ARRAY['anon', 'authenticated', 'public']::name[]
     AND (coalesce(qual, '') || ' ' || coalesce(with_check, '') LIKE '%branding%'
          OR coalesce(qual, '') || ' ' || coalesce(with_check, '') !~ 'bucket_id\s*=\s*''[^'']+''');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'mig 675: client policies on storage.objects admit the branding bucket: %', v_bad;
  END IF;

  -- 4. Every other storage.objects policy is exactly as it was.
  SELECT string_agg(policyname, ', ' ORDER BY policyname) INTO v_bad FROM (
    (SELECT * FROM mig675_other_policies
      EXCEPT
     SELECT policyname::text, permissive, cmd, roles::text, qual, with_check
       FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects')
    UNION
    (SELECT policyname::text, permissive, cmd, roles::text, qual, with_check
       FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
      EXCEPT
     SELECT * FROM mig675_other_policies)
  ) d;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'mig 675: other storage.objects policies changed: %', v_bad;
  END IF;

  -- 5. RLS is still on (the policies mean nothing without it).
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'storage.objects'::regclass) THEN
    RAISE EXCEPTION 'mig 675: row level security is off on storage.objects';
  END IF;

  RAISE NOTICE 'mig 675: branding is public for reads, writable only by service_role and signed-upload tokens, limits unchanged (200 MiB, nine types).';
END $$;

COMMIT;
