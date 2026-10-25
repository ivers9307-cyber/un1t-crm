-- 634 — SNAPSHOT.1: an immutable record of what each roster publish published.
--
-- NOT APPLIED YET. Apply BEFORE the SNAPSHOT.1 code deploys. Applied alone this
-- file changes no behaviour: a new, empty table nothing else reads. If the code
-- ever deploys first, nothing breaks for coaches: the snapshot write fails, is
-- logged (logError 'roster-snapshot') and the publish carries on unchanged; only
-- GET /api/schedule/rosters/[id]/compare errors until this exists. Behaviour is
-- proven ahead of apply by a PGlite replay
-- (tests/migration-634-roster-publish-snapshots.test.js), which runs this file
-- verbatim.
--
-- WHAT
--   public.roster_publish_snapshots — ONE row per published rosters row.
--     id               uuid PK
--     roster_id        uuid NOT NULL UNIQUE → rosters(id) ON DELETE NO ACTION
--     location_id      uuid NOT NULL → locations(id) ON DELETE CASCADE
--     period_start/end date NOT NULL (the period the publish covered)
--     published_at     timestamptz NOT NULL (copied from the rosters row)
--     published_by     uuid (copied from the rosters row; no FK, see WHY)
--     format_version   smallint NOT NULL DEFAULT 1 (the document's shape)
--     block_count      int NOT NULL = jsonb_array_length(snapshot->'blocks')
--     assignment_count int NOT NULL (live coaches across those blocks)
--     snapshot         jsonb NOT NULL: { v, period_start, period_end, blocks: [
--                        { slot, block_id, date, template_id, template_name,
--                          kind, start, end, min, max, briefing_hash,
--                          coaches: [{ assignment_id, profile_id, start, end,
--                                      overridden }] } ] }
--                      briefing_hash is the SHA-256 hex of the block's trimmed
--                      briefing (BLOCKEDIT.1, mig 629), null when none: the
--                      text itself is never stored: free text can name a
--                      person, and this row can never be corrected.
--                      It is an UNSALTED digest, so a short, guessable
--                      briefing could be confirmed by hashing a guess; the
--                      table is service role only, and the digest exists to
--                      tell "changed" from "unchanged", nothing more.
--     created_at       timestamptz NOT NULL DEFAULT now()
--
-- WHY ONE jsonb DOCUMENT (not normalised rows)
--   ~40 blocks a week x ~1.3 coaches is ~17 KB a week, ~75 KB a month before
--   TOAST compression; two studios stay well under 10 MB a year. One INSERT of
--   one row is atomic, where two tables would be two PostgREST calls with no
--   transaction between them (a half-written snapshot would read as "shifts
--   removed after publish"). It is only ever read whole, one roster at a time.
--   Template name and kind are copied in on purpose: history must not change
--   when a template is renamed or re-kinded.
--
-- WHY UNIQUE (roster_id)
--   Every publish and every re-publish inserts its OWN rosters row (POST
--   /api/schedule/rosters inserts; approve flips a draft that never published;
--   a re-publish supersedes the old row). So one snapshot per row IS one per
--   publish, and the writer's single retry is idempotent against this key.
--
-- WHY IMMUTABLE, TWICE
--   service_role gets SELECT and INSERT only (Supabase's default ALL is revoked
--   first), so no route can UPDATE, DELETE or TRUNCATE a snapshot. Triggers
--   refuse the owner as well (dashboard edits, hand-run SQL): BEFORE UPDATE
--   always, BEFORE TRUNCATE always, BEFORE DELETE unless the delete is the
--   location's cascade (see below).
--
-- WHY THE ROSTER FK IS NO ACTION, NOT CASCADE
--   Only a DRAFT roster is ever deleted (POST .../[id]/reject), and a draft
--   has no snapshot, so a CASCADE here could only ever fire on a PUBLISHED
--   roster, which is exactly when the record must survive. That is not
--   hypothetical: reject reads the roster as a draft and then deletes it, and
--   an approval landing between the two publishes and snapshots it. So a
--   snapshotted roster cannot be deleted at all (the reject route also pins
--   its delete to status = 'draft' since SNAPSHOT.1 review 2).
--
-- WHY A DELETED LOCATION STILL TAKES ITS SNAPSHOTS
--   location_id keeps ON DELETE CASCADE (and rosters.location_id cascades
--   too), so removing a whole studio removes its history with it; nothing
--   else can. The BEFORE DELETE trigger lets a delete through only at
--   pg_trigger_depth() >= 2, i.e. when it is fired from inside another
--   trigger: the RI cascade from locations is such a trigger, a direct DELETE
--   (depth 1) is not. The rosters rows the same cascade deletes pass the NO
--   ACTION check because it runs at the end of the statement, after their
--   snapshots are gone (proven in the replay). Referential actions run as the
--   table owner, so the cascade needs no DELETE grant.
--
-- WHY published_by HAS NO FK
--   rosters.published_by carries the FK already; staff profiles are never
--   deleted (tombstoned, mig 622); and an FK here would be one more hand-listed
--   dependency on profiles, whose ON DELETE SET NULL would be an UPDATE the
--   trigger refuses. No names are stored: names are read at compare time, so a
--   tombstone's PII stripping never has to reach into jsonb.
--
-- ACCESS: service role only. RLS on with NO policies, browser privileges
--   revoked (the fence is the table, not columns: mig 153/153b). Expected
--   advisor note afterwards: INFO rls_enabled_no_policy on this table, exactly
--   as widget_tokens (607) and staff_calendar_feeds (632) carry. By design.
--
-- LOCKS: CREATE TABLE / INDEX / FUNCTION / TRIGGER on a new table only. The FKs
--   to rosters and locations take a brief SHARE ROW EXCLUSIVE lock on those two
--   for the instant of the CREATE; no rows are scanned.
--
-- REPLAYING THIS FILE IS A NO-OP (IF NOT EXISTS; CREATE OR REPLACE FUNCTION;
-- DROP TRIGGER IF EXISTS + CREATE; REVOKE/GRANT/COMMENT are idempotent). One
-- explicit transaction, so a failed self-check leaves NOTHING applied.
--
-- ─────────────────────────────────────────────────────────────────────────
-- PRE-APPLY CHECKS (read-only; run IMMEDIATELY before applying, stop if any
-- answer differs from "Expected")
-- ─────────────────────────────────────────────────────────────────────────
-- (a) The names are free:
--       SELECT to_regclass('public.roster_publish_snapshots') AS t,
--              to_regprocedure('public.roster_publish_snapshots_refuse_update()') AS f,
--              to_regprocedure('public.roster_publish_snapshots_refuse_delete()') AS g;
--     Expected: t = NULL, f = NULL, g = NULL.
-- (b) The FK targets are what the file assumes:
--       SELECT table_name, data_type FROM information_schema.columns
--        WHERE table_schema='public' AND column_name='id' AND table_name IN ('rosters','locations')
--        ORDER BY 1;
--     Expected: locations uuid, rosters uuid.
-- (c) Supabase's default privileges on new public tables and functions
--     (information; KEEP the output for the rollback record):
--       SELECT pg_get_userbyid(defaclrole) AS owner, defaclobjtype, defaclacl
--         FROM pg_default_acl WHERE defaclnamespace = 'public'::regnamespace;
--     Expected: rows granting anon, authenticated and service_role.
-- (d) list_migrations shows no 634.
-- (e) Size sanity (information): a month of blocks and live coaches per studio.
--       SELECT b.location_id, count(DISTINCT b.id) AS blocks,
--              count(a.id) FILTER (WHERE a.status <> 'cancelled') AS live_coaches
--         FROM public.shift_blocks b
--         LEFT JOIN public.shift_assignments a ON a.block_id = b.id
--        WHERE b.block_date BETWEEN '2026-09-01' AND '2026-09-30'
--        GROUP BY 1;
--     Expected: a few hundred at most per studio (D1's arithmetic holds).
--
-- ─────────────────────────────────────────────────────────────────────────
-- POST-APPLY CHECKS
-- ─────────────────────────────────────────────────────────────────────────
-- (f) SELECT column_name, data_type, is_nullable FROM information_schema.columns
--      WHERE table_schema='public' AND table_name='roster_publish_snapshots' ORDER BY 1;
--     Expected 12 rows: assignment_count integer NO, block_count integer NO,
--     created_at timestamptz NO, format_version smallint NO, id uuid NO,
--     location_id uuid NO, period_end date NO, period_start date NO,
--     published_at timestamptz NO, published_by uuid YES, roster_id uuid NO,
--     snapshot jsonb NO.
-- (g) SELECT relrowsecurity FROM pg_class WHERE oid = 'public.roster_publish_snapshots'::regclass;
--     Expected: true.
--     SELECT count(*) FROM pg_policy WHERE polrelid = 'public.roster_publish_snapshots'::regclass;
--     Expected: 0.
-- (h) SELECT grantee, string_agg(privilege_type, ',' ORDER BY privilege_type)
--       FROM information_schema.table_privileges
--      WHERE table_schema='public' AND table_name='roster_publish_snapshots' GROUP BY 1 ORDER BY 1;
--     Expected: postgres (owner) holds everything; service_role exactly
--     INSERT,SELECT; NO row for anon or authenticated.
-- (i) SELECT conname FROM pg_constraint
--      WHERE conrelid = 'public.roster_publish_snapshots'::regclass AND contype <> 'n' ORDER BY 1;
--     Expected 8: roster_publish_snapshots_counts_check,
--     roster_publish_snapshots_format_version_check,
--     roster_publish_snapshots_location_id_fkey,
--     roster_publish_snapshots_period_check, roster_publish_snapshots_pkey,
--     roster_publish_snapshots_roster_id_fkey,
--     roster_publish_snapshots_roster_id_key,
--     roster_publish_snapshots_shape_check.
-- (j) SELECT tgname, tgenabled FROM pg_trigger
--      WHERE tgrelid = 'public.roster_publish_snapshots'::regclass AND NOT tgisinternal
--      ORDER BY 1;
--     Expected 3, all O: roster_publish_snapshots_immutable,
--     roster_publish_snapshots_no_delete, roster_publish_snapshots_no_truncate.
--     SELECT conname, confdeltype FROM pg_constraint
--      WHERE conrelid = 'public.roster_publish_snapshots'::regclass AND contype = 'f' ORDER BY 1;
--     Expected: location_id_fkey c, roster_id_fkey a (NO ACTION).
-- (k) SELECT count(*) FROM public.roster_publish_snapshots;   Expected: 0.
-- (l) get_advisors (security, then performance). Expected: INFO
--     rls_enabled_no_policy on roster_publish_snapshots (by design, see
--     ACCESS); possibly INFO unused_index on the new index until the first
--     compare; nothing else new. function_search_path_mutable must NOT appear
--     for roster_publish_snapshots_refuse_update or _refuse_delete (both pin
--     search_path = '').
--
-- AFTER THE FIRST REAL PUBLISH post-deploy (read-only):
--   SELECT s.roster_id, s.block_count, s.assignment_count, pg_column_size(s.snapshot) AS bytes,
--          (SELECT count(*) FROM public.shift_blocks b
--            WHERE b.location_id = s.location_id
--              AND b.block_date BETWEEN s.period_start AND s.period_end) AS blocks_now
--     FROM public.roster_publish_snapshots s ORDER BY s.created_at DESC LIMIT 5;
--   Expected: block_count = blocks_now (unless someone edited the week since),
--   bytes in the tens of KB.
--
-- ROLLBACK (forward-only repo; this is a NEW migration, never an edit here):
--   Revert the SNAPSHOT.1 code FIRST and let it deploy. Then:
--     BEGIN;
--       DROP TABLE IF EXISTS public.roster_publish_snapshots;
--       DROP FUNCTION IF EXISTS public.roster_publish_snapshots_refuse_update();
--       DROP FUNCTION IF EXISTS public.roster_publish_snapshots_refuse_delete();
--     COMMIT;
--   Every snapshot is lost for good (they cannot be rebuilt: that is the point
--   of them). Usually unnecessary: the table is inert without the code.

BEGIN;

CREATE TABLE IF NOT EXISTS public.roster_publish_snapshots (
  id               uuid        NOT NULL DEFAULT gen_random_uuid(),
  roster_id        uuid        NOT NULL,
  location_id      uuid        NOT NULL,
  period_start     date        NOT NULL,
  period_end       date        NOT NULL,
  published_at     timestamptz NOT NULL,
  published_by     uuid,
  format_version   smallint    NOT NULL DEFAULT 1,
  block_count      integer     NOT NULL,
  assignment_count integer     NOT NULL,
  snapshot         jsonb       NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT roster_publish_snapshots_pkey PRIMARY KEY (id),
  CONSTRAINT roster_publish_snapshots_roster_id_key UNIQUE (roster_id),
  CONSTRAINT roster_publish_snapshots_roster_id_fkey
    -- NO ACTION, never CASCADE: see WHY THE ROSTER FK IS NO ACTION.
    FOREIGN KEY (roster_id) REFERENCES public.rosters(id) ON DELETE NO ACTION,
  CONSTRAINT roster_publish_snapshots_location_id_fkey
    FOREIGN KEY (location_id) REFERENCES public.locations(id) ON DELETE CASCADE,
  CONSTRAINT roster_publish_snapshots_period_check CHECK (period_end >= period_start),
  CONSTRAINT roster_publish_snapshots_format_version_check CHECK (format_version >= 1),
  CONSTRAINT roster_publish_snapshots_counts_check CHECK (block_count >= 0 AND assignment_count >= 0),
  -- CASE, not AND: Postgres does not promise to evaluate AND left to right, and
  -- jsonb_array_length raises on anything that is not an array.
  CONSTRAINT roster_publish_snapshots_shape_check CHECK (
    jsonb_typeof(snapshot) = 'object'
    AND CASE WHEN jsonb_typeof(snapshot -> 'blocks') = 'array'
             THEN jsonb_array_length(snapshot -> 'blocks') = block_count
             ELSE false END
  )
);

-- The compare route's two studio-wide reads: the studio's first snapshot
-- (ORDER BY published_at LIMIT 1) and the publishes overlapping a window. The
-- leading location_id also covers the location FK; roster_id is covered by its
-- UNIQUE index.
CREATE INDEX IF NOT EXISTS roster_publish_snapshots_location_published_idx
  ON public.roster_publish_snapshots (location_id, published_at);

CREATE OR REPLACE FUNCTION public.roster_publish_snapshots_refuse_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'roster_publish_snapshots rows are immutable (SNAPSHOT.1, mig 634): a publish snapshot records what was published and is never rewritten'
    USING ERRCODE = 'check_violation';
END;
$$;

REVOKE ALL ON FUNCTION public.roster_publish_snapshots_refuse_update() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS roster_publish_snapshots_immutable ON public.roster_publish_snapshots;
CREATE TRIGGER roster_publish_snapshots_immutable
  BEFORE UPDATE ON public.roster_publish_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.roster_publish_snapshots_refuse_update();

-- A direct DELETE (depth 1) and any TRUNCATE are refused; a DELETE fired from
-- inside another trigger (the locations cascade, depth >= 2) goes through.
CREATE OR REPLACE FUNCTION public.roster_publish_snapshots_refuse_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() >= 2 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'roster_publish_snapshots rows are never deleted (SNAPSHOT.1, mig 634): they go only with their location'
    USING ERRCODE = 'check_violation';
END;
$$;

REVOKE ALL ON FUNCTION public.roster_publish_snapshots_refuse_delete() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS roster_publish_snapshots_no_delete ON public.roster_publish_snapshots;
CREATE TRIGGER roster_publish_snapshots_no_delete
  BEFORE DELETE ON public.roster_publish_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.roster_publish_snapshots_refuse_delete();

DROP TRIGGER IF EXISTS roster_publish_snapshots_no_truncate ON public.roster_publish_snapshots;
CREATE TRIGGER roster_publish_snapshots_no_truncate
  BEFORE TRUNCATE ON public.roster_publish_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION public.roster_publish_snapshots_refuse_delete();

ALTER TABLE public.roster_publish_snapshots ENABLE ROW LEVEL SECURITY;

-- Deliberately NO policies (see ACCESS in the header).
REVOKE ALL ON public.roster_publish_snapshots FROM anon, authenticated;
REVOKE ALL ON public.roster_publish_snapshots FROM service_role;
GRANT SELECT, INSERT ON public.roster_publish_snapshots TO service_role;

-- Self-check (the mig 153b habit: verify the catalog, not this text).
-- CREATE TABLE IF NOT EXISTS silently KEEPS a same-named table of another
-- shape; a RAISE here aborts the transaction, so nothing half-applies.
DO $$
DECLARE
  v_cols  text;
  v_bad   text;
  v_cons  int;
  v_trig  int;
BEGIN
  SELECT string_agg(column_name || ':' || data_type || ':' || is_nullable, ',' ORDER BY column_name)
    INTO v_cols
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'roster_publish_snapshots';
  IF v_cols IS DISTINCT FROM
     'assignment_count:integer:NO,block_count:integer:NO,created_at:timestamp with time zone:NO,format_version:smallint:NO,id:uuid:NO,location_id:uuid:NO,period_end:date:NO,period_start:date:NO,published_at:timestamp with time zone:NO,published_by:uuid:YES,roster_id:uuid:NO,snapshot:jsonb:NO' THEN
    RAISE EXCEPTION 'mig 634: roster_publish_snapshots has the wrong shape (%); a table of that name existed before this file and CREATE TABLE IF NOT EXISTS kept it', v_cols;
  END IF;

  SELECT count(*) INTO v_cons
    FROM pg_constraint
   WHERE conrelid = 'public.roster_publish_snapshots'::regclass
     AND conname IN ('roster_publish_snapshots_pkey', 'roster_publish_snapshots_roster_id_key',
                     'roster_publish_snapshots_roster_id_fkey', 'roster_publish_snapshots_location_id_fkey',
                     'roster_publish_snapshots_period_check', 'roster_publish_snapshots_format_version_check',
                     'roster_publish_snapshots_counts_check', 'roster_publish_snapshots_shape_check');
  IF v_cons <> 8 THEN
    RAISE EXCEPTION 'mig 634: expected 8 constraints on roster_publish_snapshots, found %', v_cons;
  END IF;

  SELECT count(*) INTO v_trig
    FROM pg_trigger
   WHERE tgrelid = 'public.roster_publish_snapshots'::regclass
     AND tgname IN ('roster_publish_snapshots_immutable', 'roster_publish_snapshots_no_delete',
                    'roster_publish_snapshots_no_truncate')
     AND NOT tgisinternal AND tgenabled = 'O';
  IF v_trig <> 3 THEN
    RAISE EXCEPTION 'mig 634: an immutability trigger is missing or disabled (found % of 3)', v_trig;
  END IF;

  -- The roster FK must NOT cascade (a published roster's record outlives it);
  -- the location FK must.
  IF (SELECT confdeltype FROM pg_constraint
       WHERE conname = 'roster_publish_snapshots_roster_id_fkey'
         AND conrelid = 'public.roster_publish_snapshots'::regclass) IS DISTINCT FROM 'a' THEN
    RAISE EXCEPTION 'mig 634: roster_publish_snapshots_roster_id_fkey must be ON DELETE NO ACTION';
  END IF;
  IF (SELECT confdeltype FROM pg_constraint
       WHERE conname = 'roster_publish_snapshots_location_id_fkey'
         AND conrelid = 'public.roster_publish_snapshots'::regclass) IS DISTINCT FROM 'c' THEN
    RAISE EXCEPTION 'mig 634: roster_publish_snapshots_location_id_fkey must be ON DELETE CASCADE';
  END IF;

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.roster_publish_snapshots'::regclass) THEN
    RAISE EXCEPTION 'mig 634: RLS is not enabled on roster_publish_snapshots';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.roster_publish_snapshots'::regclass) THEN
    RAISE EXCEPTION 'mig 634: roster_publish_snapshots must carry NO policies (service role only)';
  END IF;

  SELECT string_agg(r || ':' || p, ',' ORDER BY r, p) INTO v_bad
    FROM unnest(ARRAY['anon', 'authenticated']) AS r,
         unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p
   WHERE has_table_privilege(r, 'public.roster_publish_snapshots', p);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'mig 634: browser roles still hold %', v_bad;
  END IF;

  IF NOT (has_table_privilege('service_role', 'public.roster_publish_snapshots', 'SELECT')
      AND has_table_privilege('service_role', 'public.roster_publish_snapshots', 'INSERT')) THEN
    RAISE EXCEPTION 'mig 634: service_role lacks SELECT or INSERT';
  END IF;
  SELECT string_agg(p, ',' ORDER BY p) INTO v_bad
    FROM unnest(ARRAY['UPDATE', 'DELETE', 'TRUNCATE']) AS p
   WHERE has_table_privilege('service_role', 'public.roster_publish_snapshots', p);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'mig 634: service_role still holds % on an immutable table', v_bad;
  END IF;
END $$;

COMMENT ON TABLE public.roster_publish_snapshots IS
  'SNAPSHOT.1 (mig 634): what each roster publish published: every shift block in the period (date, template, kind, times, min/max) and every live coach on it (profile id, effective window), as one jsonb document per rosters row. Written once, after the publish tagged its blocks; immutable (service_role SELECT/INSERT only; UPDATE, DELETE and TRUNCATE refused by trigger, except the cascade from a deleted location; a snapshotted roster cannot be deleted). Service role only. Read by GET /api/schedule/rosters/[id]/compare.';
COMMENT ON COLUMN public.roster_publish_snapshots.format_version IS
  'Shape of the snapshot document (1 = { v, period_start, period_end, blocks: [...] }). Readers refuse a version newer than they know.';
COMMENT ON COLUMN public.roster_publish_snapshots.published_by IS
  'Copied from rosters.published_by at publish time. No FK on purpose (profiles are tombstoned, never deleted; see the migration header).';

COMMIT;
