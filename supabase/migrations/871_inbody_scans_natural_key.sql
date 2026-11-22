-- 871_inbody_scans_natural_key.sql
--
-- INBODYDEDUPE.1 — the same InBody scan can never be recorded twice.
-- Follow-up from INBODYSCOPE.1 (#2390): "the scan's idempotency key is still
-- phone + timestamp ... needs a schema decision".
--
-- NOT APPLIED YET when this file was written. APPLY BEFORE THE INBODYDEDUPE.1
-- CODE DEPLOYS. The new code upserts ON CONFLICT (location_id,
-- matched_phone9, scanned_at); without this index every ingest would fail
-- (42P10). The old code keeps working after this applies: its upsert target
-- (source, external_id) is untouched, and the only thing it newly meets is a
-- refused cross-format duplicate (23505), which it already treats as "leave
-- the event for a later retry" (so that event is re-fetched each cycle until
-- the code deploys). No scan is lost and none is doubled.
-- Behaviour is proven ahead of apply by
-- tests/migration-871-inbody-scans-natural-key.test.js (PGlite).
--
-- WHY
-- inbody_scans was unique on (source, external_id) with external_id =
-- `${phone}_${YYYYMMDDHHMMSS}`, the phone exactly as the caller spelled it.
-- One scan reaches the CRM by two roads: the webhook (InBody's own TelHP,
-- e.g. 0871234567) and the operator's "Sync InBody" backfill (whichever
-- usertoken format the Pi matched, or the CRM's +353871234567 when the Pi
-- sends none). Same scan, different spelling, different external_id: two rows.
-- The key also had no studio in it, so a re-delivery could re-home another
-- studio's row.
--
-- WHAT
--   matched_phone9: stored generated column, the last nine digits of
--   matched_phone (NULL under nine digits). The same rule as
--   normalisePhone9 in src/lib/person-links.js, so every spelling of one
--   number gives one value.
--
--   inbody_scans_natural_key: UNIQUE (location_id, matched_phone9,
--   scanned_at). One person at one studio cannot be scanned twice in the same
--   second, and InBody has no scan id of its own that reaches both roads
--   (the webhook carries EquipSerial/UserID, the backfill only the phone and
--   the datetime). Not partial, so PostgREST's on_conflict can infer it; a
--   row with no phone has a NULL key, and NULLs never collide, so legacy
--   rows without a phone stay as they are.
--
--   The self-check below refuses to apply over existing duplicates and names
--   the count, rather than failing on an opaque index error. It deletes
--   nothing: duplicates are for a person to resolve.
--
-- No grants: inbody_scans keeps mig 680's posture (own-row read for
-- authenticated; every write is service_role). A generated column takes the
-- table's existing column grants.
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS public.inbody_scans_natural_key;
--   ALTER TABLE public.inbody_scans DROP COLUMN IF EXISTS matched_phone9;

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $pre$
DECLARE
  v_groups integer;
  v_extra  integer;
BEGIN
  SELECT count(*), coalesce(sum(n - 1), 0) INTO v_groups, v_extra
    FROM (
      SELECT count(*) AS n
        FROM public.inbody_scans
       WHERE length(regexp_replace(matched_phone, '[^0-9]', '', 'g')) >= 9
       GROUP BY location_id, right(regexp_replace(matched_phone, '[^0-9]', '', 'g'), 9), scanned_at
      HAVING count(*) > 1
    ) d;
  IF v_groups > 0 THEN
    RAISE EXCEPTION '871: % InBody scan(s) recorded more than once (% surplus row(s)); resolve them before adding inbody_scans_natural_key', v_groups, v_extra;
  END IF;
END
$pre$;

ALTER TABLE public.inbody_scans
  ADD COLUMN IF NOT EXISTS matched_phone9 text
  GENERATED ALWAYS AS (
    CASE WHEN length(regexp_replace(matched_phone, '[^0-9]', '', 'g')) >= 9
         THEN right(regexp_replace(matched_phone, '[^0-9]', '', 'g'), 9)
    END
  ) STORED;

CREATE UNIQUE INDEX IF NOT EXISTS inbody_scans_natural_key
  ON public.inbody_scans (location_id, matched_phone9, scanned_at);

COMMENT ON COLUMN public.inbody_scans.matched_phone9 IS
  'INBODYDEDUPE.1 (mig 871): last nine digits of matched_phone, generated. Part of inbody_scans_natural_key (location_id, matched_phone9, scanned_at), the conflict target every writer upserts on. Never written by app code.';

COMMIT;
