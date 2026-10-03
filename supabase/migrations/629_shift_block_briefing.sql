-- 629 — BLOCKEDIT.1: a coach-visible briefing on one shift block, and a
-- change-log action for editing a block.
--
-- NOT APPLIED YET. Apply BEFORE the BLOCKEDIT.1 code deploys: that code names
-- shift_blocks.briefing in PostgREST selects (the calendar feed, the phone's
-- /api/schedule/shifts read, the Today roster, the block editor) and inserts
-- roster_change_log rows with action 'block_edited'. A select naming a column
-- that does not exist is a 400 on every call. Applied alone this file changes
-- no behaviour: every briefing is NULL and no writer uses the new action yet.
-- Behaviour is proven ahead of apply by a PGlite replay
-- (tests/migration-629-shift-block-briefing.test.js), which runs this file
-- verbatim.
--
-- WHAT
--   1. shift_blocks.briefing  text NULL
--        shift_blocks_briefing_shape CHECK (briefing IS NULL OR
--          (char_length(briefing) <= 500 AND briefing ~ '[^[:space:]]'))
--      "Not blank" is a regex, not btrim(): btrim() strips SPACES only, so
--      btrim(E'\n\t') <> '' is true and a newline-only briefing would pass
--      (caught by the PGlite replay). The API's trim() strips every
--      whitespace character; the regex matches that for ASCII whitespace.
--      A note a manager writes for the coaches on THIS shift ("fire drill at
--      10", "cover the new-member intro"). Coaches read it and never write it.
--      It is SEPARATE from shift_blocks.notes and shift_assignments.notes,
--      which are a manager's working notes.
--   2. roster_change_log.action gains 'block_edited' (the CHECK is replaced):
--        roster_change_log_action_check CHECK (action IN
--          ('assigned','unassigned','time_changed','block_edited'))
--      One coachless row per edit of a PUBLISHED block (times, minimum,
--      maximum, briefing). coach_id is NULL on it; the column has been
--      nullable since mig 236. The writer stamps notified_at in the INSERT:
--      nobody is messaged about a row with no coach, so the re-publish safety
--      net (collectUnnotifiedChanges) must never pick it up. The briefing TEXT
--      is never written into details, only 'added' | 'changed' | 'removed'.
--
-- WHY A DB CHECK AS WELL AS THE API (briefing)
--   The API caps the briefing at 500 and turns blank into NULL, but it is not
--   the only door: `authenticated` holds UPDATE on shift_blocks (table-level
--   grant) and the mig 320/605 policy shift_blocks_upd lets any manager at the
--   location write any column through the browser's client. The CHECK makes
--   the cap true of the data. The same policy is why a COACH cannot write the
--   briefing through the browser: shift_blocks_upd is manager-only.
--
-- WHY REPLACE THE ACTION CHECK BY NAME, AND SELF-CHECK IT
--   Mig 236 declared the CHECK inline on the column, so Postgres named it
--   roster_change_log_action_check. If prod's name differed, DROP ... IF
--   EXISTS would do nothing and ADD would put a SECOND check beside the old
--   one, which would still refuse 'block_edited'. The self-check counts the
--   CHECKs that mention `action` and aborts unless exactly one exists and it
--   allows 'block_edited'. Pre-check (b) confirms the name before apply.
--
-- GRANTS: none changed. Neither table has a column-level GRANT or REVOKE in
--   any migration, so the new column carries the table-level privileges.
--   Pre-check (c) confirms that against the catalog, not this text (mig 153).
--
-- LOCKS: ADD COLUMN with no default is catalog-only. Each ADD CONSTRAINT scans
--   its table once (every briefing is NULL; roster_change_log is small).
--   ACCESS EXCLUSIVE for milliseconds each.
--
-- REPLAYING THIS FILE IS A NO-OP (IF NOT EXISTS; DROP IF EXISTS then ADD).
-- One explicit transaction, so a failed self-check leaves NOTHING applied
-- (the 613/614/618/622/624/628 convention).
--
-- ─────────────────────────────────────────────────────────────────────────
-- PRE-APPLY CHECKS (read-only; run IMMEDIATELY before applying, stop if any
-- answer differs from "Expected")
-- ─────────────────────────────────────────────────────────────────────────
-- (a) The column and the new constraint name are free:
--       SELECT column_name FROM information_schema.columns
--        WHERE table_schema='public' AND table_name='shift_blocks' AND column_name='briefing';
--       SELECT conname FROM pg_constraint
--        WHERE conrelid='public.shift_blocks'::regclass AND conname='shift_blocks_briefing_shape';
--     Expected: 0 rows, 0 rows.
-- (b) roster_change_log has exactly one CHECK on action, named as mig 236 left it:
--       SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--        WHERE conrelid='public.roster_change_log'::regclass AND contype='c' ORDER BY 1;
--     Expected: ONE row, roster_change_log_action_check
--       CHECK ((action = ANY (ARRAY['assigned'::text, 'unassigned'::text, 'time_changed'::text])))
--     If the name differs, STOP: the DROP would miss it and the self-check
--     would abort the apply (safe, but fix the file first).
-- (c) Grants are table-level only (KEEP THE OUTPUT for the rollback record):
--       SELECT table_name, grantee, string_agg(privilege_type, ',' ORDER BY privilege_type)
--         FROM information_schema.table_privileges
--        WHERE table_schema='public' AND table_name IN ('shift_blocks','roster_change_log')
--          AND grantee IN ('anon','authenticated','service_role') GROUP BY 1,2 ORDER BY 1,2;
--       SELECT count(*) FROM information_schema.column_privileges c
--        WHERE c.table_schema='public' AND c.table_name IN ('shift_blocks','roster_change_log')
--          AND c.grantee IN ('anon','authenticated')
--          AND NOT EXISTS (
--            SELECT 1 FROM information_schema.table_privileges t
--             WHERE t.table_schema='public' AND t.table_name=c.table_name
--               AND t.grantee=c.grantee AND t.privilege_type=c.privilege_type);
--     Expected: authenticated holds at least SELECT on both tables; the
--     second query returns 0.
-- (d) What exists (information, not a gate; KEEP for the record):
--       SELECT action, count(*), count(*) FILTER (WHERE coach_id IS NULL) AS no_coach,
--              count(*) FILTER (WHERE notified_at IS NULL) AS unstamped
--         FROM public.roster_change_log GROUP BY 1 ORDER BY 1;
-- (e) list_migrations shows 628 and no 629.
--
-- ─────────────────────────────────────────────────────────────────────────
-- POST-APPLY CHECKS
-- ─────────────────────────────────────────────────────────────────────────
-- (f) SELECT data_type, is_nullable, column_default FROM information_schema.columns
--      WHERE table_schema='public' AND table_name='shift_blocks' AND column_name='briefing';
--     Expected: text | YES | NULL
-- (g) SELECT count(*) FILTER (WHERE briefing IS NOT NULL) FROM public.shift_blocks;
--     Expected: 0
-- (h) SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--      WHERE (conrelid='public.shift_blocks'::regclass AND conname='shift_blocks_briefing_shape')
--         OR (conrelid='public.roster_change_log'::regclass AND contype='c') ORDER BY 1;
--     Expected 2 rows:
--       roster_change_log_action_check  CHECK ((action = ANY (ARRAY['assigned'::text, 'unassigned'::text, 'time_changed'::text, 'block_edited'::text])))
--       shift_blocks_briefing_shape     CHECK (((briefing IS NULL) OR ((char_length(briefing) <= 500) AND (briefing ~ '[^[:space:]]'::text))))
-- (i) SELECT has_column_privilege('authenticated','public.shift_blocks','briefing','SELECT'),
--            has_column_privilege('service_role','public.shift_blocks','briefing','UPDATE');
--     Expected: true, true.
-- (j) The (d) query again. Expected: identical counts (no row was touched).
-- (k) get_advisors (security, then performance). Expected: nothing new.
--
-- ROLLBACK (forward-only repo; this is a NEW migration, never an edit here):
--   Revert the BLOCKEDIT.1 code FIRST and let it deploy: while that code is
--   live, dropping the column turns every select naming it into a 400.
--   Then, keeping any briefings managers wrote:
--     SELECT id, briefing FROM public.shift_blocks WHERE briefing IS NOT NULL;  -- save to the record
--     BEGIN;
--     ALTER TABLE public.shift_blocks DROP CONSTRAINT IF EXISTS shift_blocks_briefing_shape;
--     ALTER TABLE public.shift_blocks DROP COLUMN IF EXISTS briefing;
--     COMMIT;
--   Leave the widened action CHECK in place: it only ADDS a value, and
--   narrowing it back would first need every block_edited audit row deleted.

BEGIN;

ALTER TABLE public.shift_blocks
  ADD COLUMN IF NOT EXISTS briefing text;

ALTER TABLE public.shift_blocks DROP CONSTRAINT IF EXISTS shift_blocks_briefing_shape;
ALTER TABLE public.shift_blocks
  ADD CONSTRAINT shift_blocks_briefing_shape
  CHECK (briefing IS NULL OR (char_length(briefing) <= 500 AND briefing ~ '[^[:space:]]'));

COMMENT ON COLUMN public.shift_blocks.briefing IS
  'BLOCKEDIT.1 (mig 629): a note for the COACHES on this one shift, written by a manager (PUT /api/schedule/blocks/[id]); coaches read it on web and phone and never write it. At most 500 characters, never blank (NULL when absent). Separate from notes (a manager''s working note). Not copied by copy week/month.';

ALTER TABLE public.roster_change_log DROP CONSTRAINT IF EXISTS roster_change_log_action_check;
ALTER TABLE public.roster_change_log
  ADD CONSTRAINT roster_change_log_action_check
  CHECK (action IN ('assigned', 'unassigned', 'time_changed', 'block_edited'));

COMMENT ON COLUMN public.roster_change_log.action IS
  'assigned | unassigned | time_changed are per coach (coach_id set). block_edited (BLOCKEDIT.1, mig 629) is one coachless row per edit of a published shift block (times, minimum, maximum, briefing), stamped notified_at at insert because nobody is messaged about it.';

-- Self-check (the mig 153b habit: verify the catalog, not this text).
DO $$
DECLARE
  v_col record;
  v_shape int;
  v_action_checks int;
  v_action_def text;
BEGIN
  SELECT data_type, is_nullable, column_default INTO v_col
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'shift_blocks' AND column_name = 'briefing';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mig 629: shift_blocks.briefing is missing';
  END IF;
  IF v_col.data_type <> 'text' OR v_col.is_nullable <> 'YES' OR v_col.column_default IS NOT NULL THEN
    RAISE EXCEPTION 'mig 629: shift_blocks.briefing has the wrong shape (type %, nullable %, default %); a column of that name existed before this file and ADD COLUMN IF NOT EXISTS kept it',
      v_col.data_type, v_col.is_nullable, v_col.column_default;
  END IF;

  SELECT count(*) INTO v_shape
    FROM pg_constraint
   WHERE conrelid = 'public.shift_blocks'::regclass
     AND contype = 'c' AND convalidated
     AND conname = 'shift_blocks_briefing_shape';
  IF v_shape <> 1 THEN
    RAISE EXCEPTION 'mig 629: shift_blocks_briefing_shape is missing or not validated';
  END IF;

  SELECT count(*), max(pg_get_constraintdef(oid)) INTO v_action_checks, v_action_def
    FROM pg_constraint
   WHERE conrelid = 'public.roster_change_log'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%action%';
  IF v_action_checks <> 1 OR v_action_def NOT LIKE '%block_edited%' THEN
    RAISE EXCEPTION 'mig 629: expected ONE check on roster_change_log.action allowing block_edited, found % (%)',
      v_action_checks, v_action_def;
  END IF;
END $$;

COMMIT;
