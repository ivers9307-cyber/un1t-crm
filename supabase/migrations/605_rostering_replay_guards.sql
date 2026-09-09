-- 605 — ROSTER-FIX.8c: replay guards for the rostering schema.
--
-- 🔴 THIS FILE IS A NO-OP ON PRODUCTION. Every object it asserts is already
-- there. It exists so that the END STATE of the rostering schema is stated
-- once, defensively, in a file that can be replayed — because two earlier
-- migrations cannot be. Migrations are forward-only (CLAUDE.md), so 177 and
-- 320 are not edited; the hand-fixes a fresh database needs are written down
-- in `docs/migrations-replay.md` and summarised here.
--
-- HAZARD 1 — mig 177 adds a CHECK before the backfill that can violate it
-- ──────────────────────────────────────────────────────────────────────
-- 177 does, in this order:
--     alter table shift_blocks add column min_coaches ... default 1;
--     alter table shift_blocks add constraint shift_blocks_min_coaches_check
--       check (min_coaches >= 0 and min_coaches <= max_coaches);
--     update shift_blocks b set min_coaches = t.min_coaches
--       from shift_templates t where b.template_id = t.id ...;
-- The ADD passes trivially (every row is still at the default 1, and
-- max_coaches is CHECKed between 1 and 50 by mig 067). The UPDATE is the
-- problem: `shift_blocks.max_coaches` is a SNAPSHOT of the template taken at
-- block creation, so a template whose max_coaches was raised later has old
-- blocks carrying the OLD, lower max. Copy that template's min_coaches onto
-- such a block and min > max — the CHECK fires and the whole migration
-- aborts. It happened to be unreachable on the day 177 was applied; it is not
-- unreachable in general, and a replay against restored data can hit it.
-- The correct order is ADD ... NOT VALID → backfill (clamped) → VALIDATE.
--
-- HAZARD 2 — mig 320's policy rewrite is not replay-safe in either direction
-- ─────────────────────────────────────────────────────────────────────────
-- 320 consolidates permissive policies with bare `DROP POLICY "x" ON t;`
-- (no IF EXISTS — a policy that is not there aborts the file) followed by
-- `CREATE POLICY` (Postgres has no IF NOT EXISTS for CREATE POLICY — a name
-- that IS there aborts the file). So a fresh replay that diverges from prod's
-- exact history at any point, or a partial re-run, dies inside 320 and leaves
-- the rostering tables with whatever half of the rewrite got through. Since
-- RLS ORs permissive policies, "half applied" is not a visibly broken state:
-- it is a silently wider one.
--
-- Thirteen policies on four tables — rosters, shift_assignments, shift_blocks
-- and shift_swap_requests — exist ONLY in mig 320 and are re-asserted below,
-- each behind an IF NOT EXISTS check on pg_policies. (The other rostering
-- tables 320 touched — time_off_requests, staff_allowances, shift_templates —
-- are deliberately NOT here: mig 600 already re-asserts those with DROP POLICY IF
-- EXISTS + CREATE, and its definitions SUPERSEDE 320's. Re-asserting 320's
-- versions of them would reintroduce the estate-wide leak ROSTER-FIX.2 closed.)
--
-- ─────────────────────────────────────────────────────────────────────────
-- PRE-APPLY CHECKS (run read-only BEFORE applying this file)
-- ─────────────────────────────────────────────────────────────────────────
--
-- (a) 🔴 The one thing that can make this file FAIL. Section 1 ends in a
--     VALIDATE, which errors if any row violates the CHECK:
--
--       SELECT count(*) FROM public.shift_blocks
--        WHERE min_coaches > max_coaches;
--     Expected: 0. Non-zero means the constraint is not currently enforced on
--     this box (it should be — mig 177 added it validated) and the data has
--     drifted; fix those rows by hand before applying.
--
-- (b) Constraint state, to confirm section 1 really is a no-op here:
--
--       SELECT conname, convalidated
--         FROM pg_constraint
--        WHERE conrelid = 'public.shift_blocks'::regclass
--          AND conname = 'shift_blocks_min_coaches_check';
--     Expected: one row, convalidated = true. Section 1 then does nothing at
--     all (the ADD is skipped, VALIDATE on a valid constraint is a no-op).
--
-- (c) Policy state, to confirm section 2 really is a no-op here:
--
--       SELECT tablename, policyname, cmd, permissive, roles
--         FROM pg_policies
--        WHERE schemaname = 'public'
--          AND tablename IN ('rosters', 'shift_assignments',
--                            'shift_blocks', 'shift_swap_requests')
--        ORDER BY 1, 2;
--     Expected: all thirteen names below present and PERMISSIVE, plus the
--     SELECT policies from migs 067/072/109 that 320 did not touch. Every
--     guard below then skips. If a name is MISSING, this file creates it —
--     read the definition first and make sure that is what you want on this
--     box before applying.
--
-- AFTER APPLYING: get_advisors (type=security), then `npm run
-- check:rls-restrictive`. Neither should change.

-- ============================================================
-- 1. shift_blocks — min_coaches <= max_coaches (mig 177)
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.shift_blocks'::regclass
       AND conname = 'shift_blocks_min_coaches_check'
  ) THEN
    -- NOT VALID is the half mig 177 is missing: it lets the constraint exist
    -- over data that has not been checked yet, so a backfill can run between
    -- the ADD and the VALIDATE instead of being judged by a constraint that
    -- is already armed.
    ALTER TABLE public.shift_blocks
      ADD CONSTRAINT shift_blocks_min_coaches_check
      CHECK (min_coaches >= 0 AND min_coaches <= max_coaches) NOT VALID;
  END IF;
END $$;

-- No-op when the constraint is already valid (the prod case). When it is not,
-- this is where a violating row surfaces — loudly, which is the point.
ALTER TABLE public.shift_blocks
  VALIDATE CONSTRAINT shift_blocks_min_coaches_check;

-- ============================================================
-- 2. The thirteen mig-320 rostering policies
-- ============================================================
-- Definitions copied verbatim from mig 320. If you change one, change it in a
-- NEW migration — editing this file re-opens exactly the replay problem it
-- exists to close.
DO $$
DECLARE
  p record;
BEGIN
  FOR p IN
    SELECT * FROM (VALUES
      ('rosters', 'rosters_ins',
       'CREATE POLICY "rosters_ins" ON public.rosters FOR INSERT TO authenticated WITH CHECK (private.auth_is_master() OR private.auth_is_manager_at(location_id))'),
      ('rosters', 'rosters_upd',
       'CREATE POLICY "rosters_upd" ON public.rosters FOR UPDATE TO authenticated USING (private.auth_is_master() OR private.auth_is_manager_at(location_id)) WITH CHECK (private.auth_is_master() OR private.auth_is_manager_at(location_id))'),
      ('rosters', 'rosters_del',
       'CREATE POLICY "rosters_del" ON public.rosters FOR DELETE TO authenticated USING (private.auth_is_master() OR private.auth_is_manager_at(location_id))'),

      ('shift_assignments', 'shift_assignments_ins',
       'CREATE POLICY "shift_assignments_ins" ON public.shift_assignments FOR INSERT TO authenticated WITH CHECK (private.auth_is_master() OR (EXISTS ( SELECT 1 FROM shift_blocks b WHERE b.id = shift_assignments.block_id AND private.auth_is_manager_at(b.location_id))))'),
      ('shift_assignments', 'shift_assignments_upd',
       'CREATE POLICY "shift_assignments_upd" ON public.shift_assignments FOR UPDATE TO authenticated USING (private.auth_is_master() OR (EXISTS ( SELECT 1 FROM shift_blocks b WHERE b.id = shift_assignments.block_id AND private.auth_is_manager_at(b.location_id)))) WITH CHECK (private.auth_is_master() OR (EXISTS ( SELECT 1 FROM shift_blocks b WHERE b.id = shift_assignments.block_id AND private.auth_is_manager_at(b.location_id))))'),
      ('shift_assignments', 'shift_assignments_del',
       'CREATE POLICY "shift_assignments_del" ON public.shift_assignments FOR DELETE TO authenticated USING (private.auth_is_master() OR (EXISTS ( SELECT 1 FROM shift_blocks b WHERE b.id = shift_assignments.block_id AND private.auth_is_manager_at(b.location_id))))'),

      ('shift_blocks', 'shift_blocks_ins',
       'CREATE POLICY "shift_blocks_ins" ON public.shift_blocks FOR INSERT TO authenticated WITH CHECK (private.auth_is_master() OR private.auth_is_manager_at(location_id))'),
      ('shift_blocks', 'shift_blocks_upd',
       'CREATE POLICY "shift_blocks_upd" ON public.shift_blocks FOR UPDATE TO authenticated USING (private.auth_is_master() OR private.auth_is_manager_at(location_id)) WITH CHECK (private.auth_is_master() OR private.auth_is_manager_at(location_id))'),
      ('shift_blocks', 'shift_blocks_del',
       'CREATE POLICY "shift_blocks_del" ON public.shift_blocks FOR DELETE TO authenticated USING (private.auth_is_master() OR private.auth_is_manager_at(location_id))'),

      ('shift_swap_requests', 'shift_swap_requests_select',
       'CREATE POLICY "shift_swap_requests_select" ON public.shift_swap_requests FOR SELECT TO public USING (private.auth_is_admin_or_head_coach() OR ((requester_id = (select auth.uid())) OR (target_id = (select auth.uid()))))'),
      ('shift_swap_requests', 'shift_swap_requests_insert',
       'CREATE POLICY "shift_swap_requests_insert" ON public.shift_swap_requests FOR INSERT TO public WITH CHECK (private.auth_is_admin_or_head_coach() OR (requester_id = (select auth.uid())))'),
      ('shift_swap_requests', 'shift_swap_requests_update',
       'CREATE POLICY "shift_swap_requests_update" ON public.shift_swap_requests FOR UPDATE TO public USING (private.auth_is_admin_or_head_coach()) WITH CHECK (private.auth_is_admin_or_head_coach())'),
      ('shift_swap_requests', 'shift_swap_requests_delete',
       'CREATE POLICY "shift_swap_requests_delete" ON public.shift_swap_requests FOR DELETE TO public USING (private.auth_is_admin_or_head_coach())')
    ) AS t(tbl, pol, ddl)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public'
         AND tablename = p.tbl
         AND policyname = p.pol
    ) THEN
      RAISE NOTICE 'mig 605: recreating missing policy %.% (mig 320)', p.tbl, p.pol;
      EXECUTE p.ddl;
    END IF;
  END LOOP;
END $$;
