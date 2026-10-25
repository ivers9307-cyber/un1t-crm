-- 628 — SHIFTTYPE.1: a shift template is a CLASS shift or an ADMIN shift.
--
-- NOT APPLIED YET. Apply BEFORE the SHIFTTYPE.1 code deploys: that code names
-- shift_templates.kind in PostgREST selects (the calendar, the publish check,
-- the runway, the spend panel, the Studio Overview), and a select naming a
-- column that does not exist is a 400 on every call. Applied alone this file
-- changes no behaviour: every row reads 'class', which is what every row is
-- today. Behaviour is proven ahead of apply by a PGlite replay
-- (tests/migration-628-shift-template-kind.test.js), which runs this file
-- verbatim.
--
-- OWNER'S DECISION (Richard, 25 Sep 2026; recorded in the scheduler Wave 2/3
-- plan index, which lives outside this repo): roster scope is HYBRID. Templates
-- gain a type, class or admin; only admin work that needs a time and a person
-- is placed on the roster. Admin shifts carry NO MINIMUM STAFFING, so an
-- unfilled admin block is never a gap: the publish check, the staffing chips
-- and the runway alert look at class shifts only. Admin blocks stay out of the
-- contractor budget gate but still count toward hours.
--
-- WHAT
--   shift_templates.kind  text NOT NULL DEFAULT 'class'
--     shift_templates_kind_check        CHECK (kind IN ('class', 'admin'))
--     shift_templates_admin_no_minimum  CHECK (kind <> 'admin' OR min_coaches = 0)
--
-- WHY ONLY ON shift_templates (a block reads its kind through its template)
--   shift_blocks.template_id is NOT NULL REFERENCES shift_templates ON DELETE
--   RESTRICT (mig 067), so every block has exactly one template and the embed
--   is always there. min/max_coaches are snapshotted onto blocks so a template
--   edit cannot reclassify the PAST; kind has no such reason: staffing ignores
--   past blocks and hours count both kinds. A snapshot would also need every
--   block writer to copy it, and a forgotten copy is mig 611's bug again.
--
-- WHY A DB CHECK AS WELL AS THE API
--   The API refuses an admin template with a minimum, but it is not the only
--   door: `authenticated` holds UPDATE on shift_templates (table-level grant)
--   and the mig 600 policy shift_templates_upd lets any manager at the
--   location write any column through the browser's client. The CHECK makes
--   "an admin shift has no minimum" true of the data, not of one route.
--   Consequence for writers: class -> admin must set min_coaches = 0 IN THE
--   SAME UPDATE (the API does; the PGlite replay pins it).
--
-- BACKFILL: none. The column is new, so no admin row exists to fix; the
--   DEFAULT gives every existing row 'class'. Operators mark admin templates
--   in the template editor after deploy.
--
-- GRANTS: none changed. shift_templates has only table-level grants (no
--   column-level GRANT or REVOKE appears in any migration), so the new column
--   carries exactly the privileges every other column has. Pre-check (c)
--   confirms that against the catalog, not this text (the mig 153 lesson).
--
-- LOCKS: ADD COLUMN with a constant DEFAULT is catalog-only on PG >= 11 (no
--   rewrite); the two ADD CONSTRAINTs scan the table once each. 18 rows.
--
-- REPLAYING THIS FILE IS A NO-OP (IF NOT EXISTS; DROP IF EXISTS then ADD).
-- One explicit transaction, so a failed self-check leaves NOTHING applied
-- (the 613/614/618/622/624 convention).
--
-- ─────────────────────────────────────────────────────────────────────────
-- PRE-APPLY CHECKS (read-only; run IMMEDIATELY before applying, stop if any
-- answer differs from "Expected")
-- ─────────────────────────────────────────────────────────────────────────
-- (a) The column and the constraint names are free:
--       SELECT column_name FROM information_schema.columns
--        WHERE table_schema='public' AND table_name='shift_templates' AND column_name='kind';
--       SELECT conname FROM pg_constraint
--        WHERE conrelid='public.shift_templates'::regclass
--          AND conname IN ('shift_templates_kind_check','shift_templates_admin_no_minimum');
--     Expected: 0 rows, 0 rows.
-- (b) The min/max CHECKs this one sits beside are the mig 067/177 set:
--       SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--        WHERE conrelid='public.shift_templates'::regclass AND contype='c' ORDER BY 1;
--     Expected: shift_templates_days_of_week_check, shift_templates_max_coaches_check
--     (max_coaches BETWEEN 1 AND 50), shift_templates_min_coaches_check
--     (min_coaches >= 0 AND min_coaches <= max_coaches).
-- (c) Grants are table-level only (KEEP THE OUTPUT for the rollback record):
--       SELECT grantee, string_agg(privilege_type, ',' ORDER BY privilege_type)
--         FROM information_schema.table_privileges
--        WHERE table_schema='public' AND table_name='shift_templates'
--          AND grantee IN ('anon','authenticated','service_role') GROUP BY 1 ORDER BY 1;
--       SELECT count(*) FROM information_schema.column_privileges c
--        WHERE c.table_schema='public' AND c.table_name='shift_templates'
--          AND c.grantee IN ('anon','authenticated')
--          AND NOT EXISTS (
--            SELECT 1 FROM information_schema.table_privileges t
--             WHERE t.table_schema='public' AND t.table_name='shift_templates'
--               AND t.grantee = c.grantee AND t.privilege_type = c.privilege_type);
--     Expected: each role holds at least SELECT at table level; the second
--     query returns 0 (no column grant that is not also a table grant).
-- (d) What exists (information, not a gate):
--       SELECT l.name, count(*) AS templates, count(*) FILTER (WHERE t.active) AS active,
--              min(t.min_coaches), max(t.min_coaches)
--         FROM public.shift_templates t JOIN public.locations l ON l.id = t.location_id
--        GROUP BY 1 ORDER BY 1;
--     Expected (00-INDEX, 25 Sep): Stillorgan 18; Hatch Street none.
-- (e) list_migrations shows no 628.
--
-- ─────────────────────────────────────────────────────────────────────────
-- POST-APPLY CHECKS
-- ─────────────────────────────────────────────────────────────────────────
-- (f) SELECT data_type, is_nullable, column_default FROM information_schema.columns
--      WHERE table_schema='public' AND table_name='shift_templates' AND column_name='kind';
--     Expected: text | NO | 'class'::text
-- (g) SELECT kind, count(*) FROM public.shift_templates GROUP BY 1;
--     Expected: one row, class, count = the total from (d).
-- (h) SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--      WHERE conrelid='public.shift_templates'::regclass
--        AND conname IN ('shift_templates_kind_check','shift_templates_admin_no_minimum') ORDER BY 1;
--     Expected 2 rows:
--       shift_templates_admin_no_minimum  CHECK (((kind <> 'admin'::text) OR (min_coaches = 0)))
--       shift_templates_kind_check        CHECK ((kind = ANY (ARRAY['class'::text, 'admin'::text])))
-- (i) SELECT has_column_privilege('authenticated','public.shift_templates','kind','SELECT'),
--            has_column_privilege('service_role','public.shift_templates','kind','UPDATE');
--     Expected: true, true.
-- (j) get_advisors (security, then performance). Expected: nothing new (no
--     table, policy, view or function was created).
--
-- ROLLBACK (forward-only repo; this is a NEW migration, never an edit here):
--   Revert the SHIFTTYPE.1 code FIRST and let it deploy: while that code is
--   live, dropping the column turns every select naming it into a 400. Then:
--     BEGIN;
--     ALTER TABLE public.shift_templates DROP CONSTRAINT IF EXISTS shift_templates_admin_no_minimum;
--     ALTER TABLE public.shift_templates DROP CONSTRAINT IF EXISTS shift_templates_kind_check;
--     ALTER TABLE public.shift_templates DROP COLUMN IF EXISTS kind;
--     COMMIT;
--   Usually unnecessary: with every row 'class' the column is inert.

BEGIN;

ALTER TABLE public.shift_templates
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'class';

ALTER TABLE public.shift_templates DROP CONSTRAINT IF EXISTS shift_templates_kind_check;
ALTER TABLE public.shift_templates
  ADD CONSTRAINT shift_templates_kind_check
  CHECK (kind IN ('class', 'admin'));

ALTER TABLE public.shift_templates DROP CONSTRAINT IF EXISTS shift_templates_admin_no_minimum;
ALTER TABLE public.shift_templates
  ADD CONSTRAINT shift_templates_admin_no_minimum
  CHECK (kind <> 'admin' OR min_coaches = 0);

COMMENT ON COLUMN public.shift_templates.kind IS
  'SHIFTTYPE.1 (mig 628): class (default) or admin. An admin shift has NO minimum staffing (min_coaches = 0, CHECK shift_templates_admin_no_minimum): it is never an empty or short gap on any staffing surface, and it is excluded from the contractor budget gate and contractor spend. Its hours still count everywhere hours are counted. A shift_block reads its kind through template_id; it is deliberately not snapshotted onto shift_blocks.';

-- Self-check (the mig 153b habit: verify the catalog, not this text).
-- ADD COLUMN IF NOT EXISTS silently KEEPS a column of the same name that some
-- earlier hand edit created; if its shape differs (nullable, no default) the
-- CHECKs above still pass on NULLs and nothing would say so. A RAISE here
-- aborts the transaction, so nothing half-applies.
DO $$
DECLARE
  v_col record;
  v_checks int;
BEGIN
  SELECT data_type, is_nullable, column_default INTO v_col
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'shift_templates' AND column_name = 'kind';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mig 628: shift_templates.kind is missing';
  END IF;
  IF v_col.data_type <> 'text'
     OR v_col.is_nullable <> 'NO'
     OR v_col.column_default IS DISTINCT FROM '''class''::text' THEN
    RAISE EXCEPTION 'mig 628: shift_templates.kind has the wrong shape (type %, nullable %, default %); a column of that name existed before this file and ADD COLUMN IF NOT EXISTS kept it',
      v_col.data_type, v_col.is_nullable, v_col.column_default;
  END IF;

  SELECT count(*) INTO v_checks
    FROM pg_constraint
   WHERE conrelid = 'public.shift_templates'::regclass
     AND contype = 'c'
     AND convalidated
     AND conname IN ('shift_templates_kind_check', 'shift_templates_admin_no_minimum');
  IF v_checks <> 2 THEN
    RAISE EXCEPTION 'mig 628: expected 2 validated CHECKs on shift_templates.kind, found %', v_checks;
  END IF;
END $$;

COMMIT;
