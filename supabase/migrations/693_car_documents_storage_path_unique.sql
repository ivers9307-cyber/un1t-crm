-- 693 — CARDOCUNIQUE.1 (C129): one car_documents row per stored object.
-- A unique index on car_documents(storage_path); nothing is deleted.
--
-- NOT APPLIED YET when this file was written. "VERIFIED LIVE" below is prod
-- BEFORE this file runs (read-only, Supabase MCP, 2 Oct 2026). Behaviour is
-- proven ahead of apply by tests/migration-693-car-documents-storage-path-unique.test.js.
--
-- ===========================================================================
-- THE FINDING (follow-ups C129, found reviewing C124 CARDOCUPLOAD.1)
-- ===========================================================================
-- POST /api/cars/[id]/documents/finalise refuses a replay with a 409 by
-- READING for a row on the slot's path and then inserting. Two concurrent
-- calls on one slot both read nothing and both insert: two car_documents
-- rows on one object and two bookkeeper-queue entries (a possible duplicate
-- Xero bill). car_documents has had no unique key on storage_path since
-- mig 025. Only a caller holding 'car_processing' can race it.
--
-- VERIFIED LIVE (2 Oct, BEFORE this migration): 12 rows, storage_path text
-- NOT NULL, 0 paths held by more than one row (also 0 on 1 Oct); indexes:
-- the pkey, idx_car_documents_car, idx_car_documents_type, and five partial
-- or FK indexes, none on storage_path; 176 kB. relacl
-- {postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres} (mig 674: no
-- client privilege), so only the service-role routes insert.
--
-- ===========================================================================
-- THE FIX
-- ===========================================================================
--   CREATE UNIQUE INDEX car_documents_storage_path_key ON
--   public.car_documents (storage_path). The losing insert now fails 23505;
--   src/lib/car-document-record.js reports it as a conflict and, unlike any
--   other insert failure, does NOT remove the stored object (the winner's
--   row points at it); both routes answer 409. Not CONCURRENTLY: 12 rows,
--   one short lock inside this transaction.
--
-- APPLY: after this PR merges, apply 692 then 693; pre/post probes and the
-- rollback (DROP INDEX) are in the PR body.
-- ===========================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- Pre-check: no path is already held twice (the index would fail to build).
DO $$
DECLARE
  v_dupes int;
BEGIN
  SELECT count(*) INTO v_dupes
    FROM (SELECT storage_path FROM public.car_documents GROUP BY storage_path HAVING count(*) > 1) d;
  IF v_dupes > 0 THEN
    RAISE EXCEPTION 'mig 693: % storage_path value(s) on public.car_documents are held by more than one row; resolve them before applying', v_dupes;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS car_documents_storage_path_key ON public.car_documents (storage_path);

-- Self-check: the catalog, never this file's text. IF NOT EXISTS would keep
-- an index already holding the name, whatever its definition.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.oid = to_regclass('public.car_documents_storage_path_key')
       AND i.indrelid = 'public.car_documents'::regclass
       AND i.indisunique AND i.indisvalid AND i.indisready
       AND i.indnatts = 1
       AND i.indkey[0] = (SELECT attnum FROM pg_attribute
                           WHERE attrelid = 'public.car_documents'::regclass AND attname = 'storage_path')
       AND i.indpred IS NULL AND i.indexprs IS NULL
  ) THEN
    RAISE EXCEPTION 'mig 693: public.car_documents_storage_path_key is not a valid unique index on exactly (storage_path)';
  END IF;
  RAISE NOTICE 'mig 693: car_documents.storage_path is unique (car_documents_storage_path_key).';
END $$;

COMMIT;
