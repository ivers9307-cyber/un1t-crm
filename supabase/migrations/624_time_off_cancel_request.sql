-- 624 — LEAVECANCEL.1: a manager cancelling their OWN APPROVED leave needs an
-- owner's approval.
--
-- NOT APPLIED YET. Apply BEFORE the code that depends on it deploys: the new
-- PUT branch and POST/DELETE /api/schedule/time-off/[id]/cancel-request write
-- these columns; GET /api/schedule/time-off reads them through `*` AND embeds
-- `cancel_decider:profiles!cancel_decided_by(id, full_name)`, which needs the
-- cancel_decided_by FK this file creates (without it PostgREST refuses the
-- embed hint, PGRST200); and the Leave cancellations approvals provider
-- filters on cancel_requested_at / cancel_decided_at. Each of those readers
-- falls back or answers empty, and logs, when the columns are missing (a
-- Vercel preview of this branch runs against prod before the apply), so an
-- ordering slip turns the new feature off rather than the leave list. It is
-- still a slip: apply first.
-- Behaviour is proven ahead of apply by a PGlite replay
-- (tests/migration-624-time-off-cancel-request.test.js), which installs the
-- mig 011/616 allowance trigger and the mig 600 policies, runs this file
-- verbatim and asserts everything the header claims.
--
-- OWNER'S DECISION (20 Sep 2026): "A manager cancelling their OWN APPROVED
-- leave must need the OWNER's approval."
--
-- THE HOLE. PUT /api/schedule/time-off/[id] refuses a plain coach who tries to
-- cancel their own approved leave, but the refusal is skipped for a caller who
-- holds a manager-tier role at a studio the request belongs to. So a manager,
-- head coach or owner could set their own APPROVED leave to `cancelled` with
-- nobody told, while approved leave moves the holiday allowance (the
-- mig 011/616 trigger) and other people plan the roster around it.
--
-- ===========================================================================
-- 1. THE ASK IS COLUMNS, NOT A STATUS
-- ===========================================================================
-- While a cancellation waits for a decision the leave is STILL APPROVED and
-- still in force. Every reader that treats status='approved' as "on leave"
-- (copy-week skip, leave clashes, the publish preview, the calendars, the
-- allowance maths) must keep doing so untouched, so there is no new `status`
-- value and the status CHECK (mig 011) is not changed.
--
--   cancel_requested_at / cancel_requested_by / cancel_request_note
--     the ask. `by` is always the person whose leave it is (the route allows
--     nobody else to ask); stored anyway so the row says so itself.
--   cancel_decided_at / cancel_decided_by / cancel_decision / cancel_decision_note
--     the answer. 'approved' lands in the SAME UPDATE that sets
--     status='cancelled'; 'rejected' leaves status='approved'.
--
--   An OPEN ask  = cancel_requested_at IS NOT NULL
--                  AND cancel_decided_at IS NULL AND status = 'approved'
--                  (and, in the app, end_date >= today in Dublin: an ask lapses
--                  with the leave, derived at read time like a pending
--                  request's expiry, LEAVE.2 — never stored, no cron).
--   WITHDRAWN    = the requester clears all seven columns back to NULL.
--   RE-ASK       = after a rejection the requester may ask again; the new ask
--                  overwrites the old answer (cancel_decided_* back to NULL).
--
-- `status = 'approved'` is part of the open-ask predicate ON PURPOSE rather
-- than a CHECK tying the ask to the status: a colleague with authority may
-- still cancel or reject the leave outright through the PUT (unchanged, out of
-- scope), and the mig 622 tombstone function rewrites status too. A CHECK
-- there would turn those legitimate writes into constraint errors; with the
-- predicate, an ask on leave that is no longer approved is simply moot.
--
-- The CHECKs below only forbid rows that contradict THEMSELVES:
--   * a decision without an ask;
--   * half an ask (at without by, or the reverse);
--   * half a decision (any of at / by / decision without the other two);
--   * a decision value outside approved|rejected;
--   * cancel_decision='approved' on a row that is not cancelled (the approve
--     UPDATE sets both at once, so a row claiming an approved cancellation
--     while still in force is a forgery or a half-applied write).
--     CONSEQUENCE, handled in the PUT and pinned by the replay: moving a row
--     whose cancellation was APPROVED to any other status (an approver
--     re-approving cancelled leave) must clear the seven columns in the same
--     UPDATE, or this CHECK refuses it. No other writer moves a cancelled row.
--
-- FKs INTO profiles. Plain REFERENCES (NO ACTION), the same as `reviewed_by`
-- (mig 011). A staff profile is never deleted (tombstoned instead, mig 622),
-- so no delete action should ever fire; if a hard delete is ever attempted,
-- NO ACTION refuses it rather than silently erasing who asked or who decided.
-- Deliberately NOT CASCADE (it would take the leave row with the decider) and
-- NOT SET NULL (it would break the pairing CHECKs and lose the answer's
-- author). time_off_requests.profile_id itself is CASCADE (mig 011) and is
-- left alone.
--
-- ===========================================================================
-- 2. THE BROWSER LOSES ITS UPDATE GRANT ON time_off_requests
-- ===========================================================================
-- `time_off_requests_update` (mig 600) lets any manager-tier member of the
-- row's studio UPDATE any column of any row there through the browser's
-- RLS-bound client: `private.auth_is_manager_at(location_id)` with a WITH
-- CHECK that is the same expression. So the rule this file exists for could be
-- walked around with one hand-written PostgREST call (status='cancelled' on
-- your own approved leave), and the new columns would add a second problem: a
-- manager could WRITE `cancel_decided_by = <an owner's id>` and forge the
-- approval. Same blind spot as mig 618/622: the API route is not the only
-- door.
--
-- CONSUMERS CHECKED (grep "time_off_requests" over src/ shared/ mobile/, and
-- champ-app + un1t-platform, 21 Sep 2026): every WRITE goes through a
-- service-role route (POST + PUT /api/schedule/time-off, the mig 622
-- tombstone function). The only RLS-bound reader is
-- shared/dashboard-data.js (mobile, anon-key client), a SELECT of
-- id/type/start_date/end_date/status/created_at. No browser or phone code
-- updates this table, and `git log -S` finds none that ever did.
--
-- So UPDATE is revoked from `authenticated` and `anon`. SELECT is untouched
-- (the new columns are readable by exactly who can read `reason` and
-- `review_note` today: the person, and manager-tier staff at the row's
-- studio). INSERT is untouched too and is a SEPARATE finding, not fixed here:
-- "Staff can create own time off" (mig 048) checks only profile_id =
-- auth.uid(), so a hand-written INSERT can create a row already `approved`.
-- DELETE has no policy, so RLS already refuses it.
--
-- A table-level REVOKE also removes matching column-level grants. Verified
-- against the catalog by the DO block below, never against this text (the
-- mig 153 lesson); one explicit transaction so a failed self-check leaves
-- NOTHING applied (the 613/614/618/622 convention).
--
-- ─────────────────────────────────────────────────────────────────────────
-- PRE-APPLY CHECKS (read-only)
-- ─────────────────────────────────────────────────────────────────────────
-- LAST OBSERVED 21 SEP 2026. These read-only queries were run by the session
-- orchestrating this PR, through the Supabase MCP, against project
-- iyvtbjjxdggiadzwwvdj. (The branch's code reviewer touched no database.)
-- What they showed then: (a) no cancel_* columns; (b)
-- trg_update_holiday_allowance enabled, AFTER UPDATE, and the live
-- update_holiday_allowance() body equal to mig 616's minus one comment line;
-- (c) every anon/authenticated grant on time_off_requests with grantor
-- `postgres`, and the table owner `postgres`, so this file's REVOKE removes
-- them; (d) exactly the three policies named below. 9 approved leave rows
-- were still in the future.
-- State drifts: whoever applies this file RE-RUNS (a) to (d) IMMEDIATELY
-- BEFORE applying, and stops if any answer differs from "Expected".
--
-- (a) The columns do not exist yet and the number is free:
--       SELECT column_name FROM information_schema.columns
--        WHERE table_schema='public' AND table_name='time_off_requests'
--          AND column_name LIKE 'cancel\_%';
--     Expected: 0 rows.
--
-- (b) The allowance trigger is the mig 616 body and still refunds on
--     approved -> cancelled (the approve path relies on it; read from the
--     migrations, NOT verified on prod by this branch):
--       SELECT pg_get_functiondef('public.update_holiday_allowance()'::regprocedure);
--     Expected: contains
--       IF NEW.type = 'holiday' AND OLD.status = 'approved' AND NEW.status IN ('cancelled', 'rejected')
--       ... SET used_days = GREATEST(0, used_days - OLD.total_days)
--       SELECT tgname, tgenabled FROM pg_trigger
--        WHERE tgrelid = 'public.time_off_requests'::regclass AND NOT tgisinternal;
--     Expected: trg_update_holiday_allowance, tgenabled = 'O'.
--
-- (c) The grants this file revokes. KEEP THE OUTPUT, it is the rollback recipe:
--       SELECT grantor, grantee, privilege_type, NULL AS column_name
--         FROM information_schema.table_privileges
--        WHERE table_schema='public' AND table_name='time_off_requests'
--          AND grantee IN ('anon','authenticated')
--       UNION ALL
--       SELECT grantor, grantee, privilege_type, column_name
--         FROM information_schema.column_privileges
--        WHERE table_schema='public' AND table_name='time_off_requests'
--          AND grantee IN ('anon','authenticated') AND privilege_type = 'UPDATE'
--        ORDER BY 2, 3, 4;
--     GRANTOR MATTERS: a REVOKE removes only grants made by the revoking role.
--     Mig 622 found grantor = `postgres` on profiles; expect the same here. If
--     another grantor shows, the self-check below aborts the whole apply;
--     revoke that grant as its grantor first.
--
-- (d) The policies are the mig 600 pair (this file does not touch them):
--       SELECT policyname, cmd FROM pg_policies WHERE tablename='time_off_requests' ORDER BY 1;
--     Expected: "Staff can create own time off" INSERT, time_off_requests_select
--     SELECT, time_off_requests_update UPDATE.
--
-- ─────────────────────────────────────────────────────────────────────────
-- POST-APPLY CHECKS
-- ─────────────────────────────────────────────────────────────────────────
-- (e) SELECT column_name, data_type FROM information_schema.columns
--      WHERE table_schema='public' AND table_name='time_off_requests'
--        AND column_name LIKE 'cancel\_%' ORDER BY 1;
--     Expected 7 rows: cancel_decided_at, cancel_decided_by, cancel_decision,
--     cancel_decision_note, cancel_request_note, cancel_requested_at,
--     cancel_requested_by.
-- (f) SELECT conname FROM pg_constraint
--      WHERE conrelid='public.time_off_requests'::regclass AND conname LIKE 'time_off_requests_cancel%' ORDER BY 1;
--     Expected 7 rows (the three generated names are what Postgres 16 produced
--     in the PGlite replay, which asserts this exact list):
--       time_off_requests_cancel_approved_is_cancelled   CHECK
--       time_off_requests_cancel_ask_pair                CHECK
--       time_off_requests_cancel_decided_by_fkey         FK, confdeltype 'a'
--       time_off_requests_cancel_decision_check          CHECK (generated)
--       time_off_requests_cancel_decision_needs_ask      CHECK
--       time_off_requests_cancel_decision_trio           CHECK
--       time_off_requests_cancel_requested_by_fkey       FK, confdeltype 'a'
-- (g) SELECT has_table_privilege('authenticated','public.time_off_requests','UPDATE'),
--            has_table_privilege('anon','public.time_off_requests','UPDATE'),
--            has_table_privilege('authenticated','public.time_off_requests','SELECT'),
--            has_table_privilege('service_role','public.time_off_requests','UPDATE');
--     Expected: false, false, true, true.
-- (h) SELECT count(*) FROM public.time_off_requests WHERE cancel_requested_at IS NOT NULL;   -- 0
-- (i) get_advisors (type = security). Expected: nothing new.
--
-- AFTER THE FIRST REAL ASK + APPROVAL (code deployed), for that request id:
-- (j) SELECT status, cancel_requested_at, cancel_decided_at, cancel_decision, cancel_decided_by
--       FROM public.time_off_requests WHERE id = :id;
--     While waiting: status 'approved', requested set, decided NULL.
--     After approve: status 'cancelled', decision 'approved', decided_by = the owner.
--     And for a holiday, staff_allowances.used_days for (profile, year of
--     start_date) dropped by the row's total_days at the approve, not at the ask.

BEGIN;

ALTER TABLE public.time_off_requests
  ADD COLUMN IF NOT EXISTS cancel_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancel_requested_by uuid REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS cancel_request_note text,
  ADD COLUMN IF NOT EXISTS cancel_decided_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancel_decided_by uuid REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS cancel_decision text CHECK (cancel_decision IN ('approved', 'rejected')),
  ADD COLUMN IF NOT EXISTS cancel_decision_note text;

COMMENT ON COLUMN public.time_off_requests.cancel_requested_at IS
  'LEAVECANCEL.1 (mig 624): when the person asked for their own APPROVED leave to be cancelled. The leave stays approved and in force until an owner decides. An OPEN ask = this set, cancel_decided_at NULL, status = approved. NULL again = never asked, or withdrawn.';
COMMENT ON COLUMN public.time_off_requests.cancel_requested_by IS
  'LEAVECANCEL.1 (mig 624): who asked. Always the person whose leave it is. Set together with cancel_requested_at.';
COMMENT ON COLUMN public.time_off_requests.cancel_request_note IS
  'LEAVECANCEL.1 (mig 624): the requester''s optional reason for the cancellation.';
COMMENT ON COLUMN public.time_off_requests.cancel_decided_at IS
  'LEAVECANCEL.1 (mig 624): when the cancellation was decided. Set together with cancel_decided_by and cancel_decision.';
COMMENT ON COLUMN public.time_off_requests.cancel_decided_by IS
  'LEAVECANCEL.1 (mig 624): the OWNER (at a studio the request belongs to) or master who decided. Never the requester.';
COMMENT ON COLUMN public.time_off_requests.cancel_decision IS
  'LEAVECANCEL.1 (mig 624): approved | rejected. approved is written in the same UPDATE that sets status = cancelled; rejected leaves status = approved.';
COMMENT ON COLUMN public.time_off_requests.cancel_decision_note IS
  'LEAVECANCEL.1 (mig 624): the decider''s optional note to the requester.';

-- A row may not contradict itself. DROP + ADD so the file can be re-run.
ALTER TABLE public.time_off_requests DROP CONSTRAINT IF EXISTS time_off_requests_cancel_ask_pair;
ALTER TABLE public.time_off_requests
  ADD CONSTRAINT time_off_requests_cancel_ask_pair
  CHECK ((cancel_requested_at IS NULL) = (cancel_requested_by IS NULL));

ALTER TABLE public.time_off_requests DROP CONSTRAINT IF EXISTS time_off_requests_cancel_decision_trio;
ALTER TABLE public.time_off_requests
  ADD CONSTRAINT time_off_requests_cancel_decision_trio
  CHECK ((cancel_decided_at IS NULL) = (cancel_decided_by IS NULL)
     AND (cancel_decided_at IS NULL) = (cancel_decision IS NULL));

ALTER TABLE public.time_off_requests DROP CONSTRAINT IF EXISTS time_off_requests_cancel_decision_needs_ask;
ALTER TABLE public.time_off_requests
  ADD CONSTRAINT time_off_requests_cancel_decision_needs_ask
  CHECK (cancel_decided_at IS NULL OR cancel_requested_at IS NOT NULL);

ALTER TABLE public.time_off_requests DROP CONSTRAINT IF EXISTS time_off_requests_cancel_approved_is_cancelled;
ALTER TABLE public.time_off_requests
  ADD CONSTRAINT time_off_requests_cancel_approved_is_cancelled
  CHECK (cancel_decision IS DISTINCT FROM 'approved' OR status = 'cancelled');

-- The approvals queue asks for OPEN asks only; there will be a handful at most
-- among every approved row, so a partial index keeps that read off the table.
CREATE INDEX IF NOT EXISTS time_off_requests_open_cancel_ask_idx
  ON public.time_off_requests (cancel_requested_at)
  WHERE cancel_requested_at IS NOT NULL AND cancel_decided_at IS NULL AND status = 'approved';

-- Covering indexes for the two FKs (advisor unindexed_foreign_keys).
CREATE INDEX IF NOT EXISTS time_off_requests_cancel_requested_by_idx
  ON public.time_off_requests (cancel_requested_by) WHERE cancel_requested_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS time_off_requests_cancel_decided_by_idx
  ON public.time_off_requests (cancel_decided_by) WHERE cancel_decided_by IS NOT NULL;

-- ─── anon / authenticated lose UPDATE on time_off_requests (section 2) ──────
REVOKE UPDATE ON public.time_off_requests FROM anon, authenticated;

DO $$
DECLARE
  v_left integer;
BEGIN
  SELECT (SELECT count(*) FROM information_schema.table_privileges
           WHERE table_schema = 'public' AND table_name = 'time_off_requests'
             AND grantee IN ('anon', 'authenticated') AND privilege_type = 'UPDATE')
       + (SELECT count(*) FROM information_schema.column_privileges
           WHERE table_schema = 'public' AND table_name = 'time_off_requests'
             AND grantee IN ('anon', 'authenticated') AND privilege_type = 'UPDATE')
    INTO v_left;
  IF v_left > 0 THEN
    RAISE EXCEPTION 'mig 624: % UPDATE privilege(s) on public.time_off_requests still held by anon/authenticated', v_left;
  END IF;
END $$;

COMMIT;
