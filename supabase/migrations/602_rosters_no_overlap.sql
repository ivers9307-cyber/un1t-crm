-- 602 — ROSTER-SUPERSEDE.1: no two PUBLISHED rosters may cover the same day
-- at the same location, and a publish SUPERSEDES the rosters it swallows.
--
-- 🔴 THIS FILE WAS REWRITTEN IN PLACE ON 2026-09-09, and that is correct.
-- 602 was written under ROSTER-FIX.4 and never applied — anywhere. Production
-- is at 605, so 602 is a deliberate gap in the sequence, not a file that ran.
-- Forward-only (CLAUDE.md) fences editing migrations that HAVE been applied,
-- because the directory is the record of the live box; a file that has never
-- touched a database is not part of that record. Rewriting it keeps ONE file
-- per concept ("published rosters do not overlap") instead of leaving a dead
-- 602 next to a 606 that supersedes it. If this file has been applied by the
-- time you read it, the rule flips back: change it in a NEW migration.
--
-- DECISION (Richard, 2026-09-09). The old header listed three blockers, two of
-- which were the same question: what a re-publish DOES to the roster row it
-- swallows. The answer is SUPERSEDE — the swallowed row keeps its audit
-- identity, gains `status='superseded'` plus `superseded_by`/`superseded_at`
-- pointing at the roster that took its blocks, and stops claiming days it owns
-- no blocks for. Nothing is deleted and nothing is silently re-dated.
--
-- ── THE MODEL (verified against live prod data 2026-09-09, do not re-derive) ─
--
-- Publishing INSERTs a `rosters` row and then re-tags every
-- `shift_blocks.roster_id` in the period. So OWNERSHIP IS PER BLOCK: a
-- roster's `period_start`/`period_end` is the range the operator REQUESTED,
-- not a claim on those days. A later publish over the same range takes the
-- blocks and leaves the older row claiming dates it owns nothing on.
--
-- Prod today: 74 published rosters. 58 own ZERO blocks (fully taken over by a
-- later publish), 16 own blocks, every owner's day-set is CONTIGUOUS, and
-- shrinking each owner to the days it actually owns leaves ZERO overlapping
-- pairs. That is what makes this constraint applicable at all: the overlaps
-- on disk are all bookkeeping, none of them are two rosters genuinely
-- publishing the same day.
--
-- ── PRE-APPLY CHECKS (run read-only BEFORE applying; expected values given) ──
--
-- (a) Published rosters owning ZERO blocks — the rows step 2 supersedes:
--
--       SELECT count(*) FROM public.rosters r
--        WHERE r.status = 'published'
--          AND NOT EXISTS (SELECT 1 FROM public.shift_blocks b
--                           WHERE b.roster_id = r.id);
--     Expected: 58.
--
-- (b) Published rosters that DO own blocks — the rows step 3 shrinks:
--
--       SELECT count(*) FROM public.rosters r
--        WHERE r.status = 'published'
--          AND EXISTS (SELECT 1 FROM public.shift_blocks b
--                       WHERE b.roster_id = r.id);
--     Expected: 16. (a) + (b) = 74.
--
-- (c) Owners whose owned days are NOT contiguous. A gap would mean shrinking
--     to min/max re-claims a day the roster does not own, which could
--     manufacture an overlap the data does not really have:
--
--       SELECT count(*) FROM (
--         SELECT b.roster_id
--           FROM public.shift_blocks b
--           JOIN public.rosters r ON r.id = b.roster_id AND r.status = 'published'
--          GROUP BY b.roster_id
--         HAVING count(DISTINCT b.block_date)
--                <> (max(b.block_date) - min(b.block_date) + 1)
--       ) x;
--     Expected: 0.
--
-- (d) 🔴 THE ONE THAT DECIDES WHETHER THIS FILE CAN APPLY. Overlapping pairs
--     AFTER the shrink in step 3 — i.e. what the exclusion constraint will
--     actually judge:
--
--       WITH owned AS (
--         SELECT b.roster_id, min(b.block_date) AS s, max(b.block_date) AS e
--           FROM public.shift_blocks b
--           JOIN public.rosters r ON r.id = b.roster_id AND r.status = 'published'
--          GROUP BY b.roster_id
--       )
--       SELECT count(*)
--         FROM public.rosters ra JOIN owned oa ON oa.roster_id = ra.id
--         JOIN public.rosters rb ON rb.location_id = ra.location_id AND ra.id < rb.id
--         JOIN owned ob ON ob.roster_id = rb.id
--        WHERE daterange(oa.s, oa.e, '[]') && daterange(ob.s, ob.e, '[]');
--     Expected: 0. Non-zero means two rosters really do own the same day and
--     an operator has to say which one wins — step 4's guard will abort the
--     file rather than half-apply, but knowing before you start is cheaper.
--
-- (e) Informational — overlapping pairs as the rows stand TODAY. This is the
--     check the old header called "must be zero"; it is NOT zero and does not
--     need to be, because steps 2 and 3 are what make (d) zero:
--
--       SELECT count(*) FROM public.rosters a JOIN public.rosters b
--         ON a.location_id = b.location_id AND a.id < b.id
--        AND a.status = 'published' AND b.status = 'published'
--        AND daterange(a.period_start, a.period_end, '[]')
--         && daterange(b.period_start, b.period_end, '[]');
--
-- AFTER APPLYING: `get_advisors` (type=security), then re-run (d) — it must
-- still be 0 — and confirm `rosters_no_overlapping_published` exists in
-- `pg_constraint`.
--
-- ── WHAT THE APP DOES WITH THIS (ROSTER-SUPERSEDE.1, same PR) ───────────────
-- `supersedeSwallowedRosters()` in `src/lib/roster-publish.js` keeps the
-- invariant going forward: both publish paths release the rosters their period
-- fully contains BEFORE inserting (the constraint judges the INSERT, so the
-- release has to precede it), then stamp `superseded_by` after the re-tag.
-- A STRADDLING overlap is still refused with a 409 by
-- `findConflictingPublishedRosters()` — shrinking a roster nobody asked to
-- change is not something to do silently.

-- btree_gist is what lets `location_id WITH =` (an equality op on a scalar)
-- share a GiST index with a range `&&`.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ============================================================
-- 1. Columns
-- ============================================================
-- superseded_by is nullable ON PURPOSE. The backfill below cannot always name
-- the roster that took a given row's blocks (a location's whole history can
-- have been rewritten by several later publishes), and "superseded, successor
-- unknown" is a truthful state. ON DELETE SET NULL keeps the tombstone when a
-- successor is deleted, matching shift_blocks.roster_id's own FK (mig 072).
ALTER TABLE public.rosters
  ADD COLUMN IF NOT EXISTS superseded_by uuid
    REFERENCES public.rosters(id) ON DELETE SET NULL;

ALTER TABLE public.rosters
  ADD COLUMN IF NOT EXISTS superseded_at timestamptz;

-- The range the operator actually clicked. period_start/period_end are shrunk
-- below (and by the app, on every publish) to the days a roster really owns,
-- which is what the exclusion constraint needs — but the audit question "what
-- did this person ask to publish?" must not be rewritten silently to answer a
-- constraint. These two columns are the un-shrunk original.
ALTER TABLE public.rosters
  ADD COLUMN IF NOT EXISTS requested_period_start date;
ALTER TABLE public.rosters
  ADD COLUMN IF NOT EXISTS requested_period_end date;

COMMENT ON COLUMN public.rosters.superseded_by IS
  'ROSTER-SUPERSEDE.1 (mig 602) — the roster whose publish took this one''s blocks. NULL is legitimate: superseded with no identifiable successor.';
COMMENT ON COLUMN public.rosters.superseded_at IS
  'ROSTER-SUPERSEDE.1 (mig 602) — when this roster stopped owning any blocks.';
COMMENT ON COLUMN public.rosters.requested_period_start IS
  'ROSTER-SUPERSEDE.1 (mig 602) — the period the operator requested at publish time. period_start is shrunk to the days this roster actually owns; this is not.';
COMMENT ON COLUMN public.rosters.requested_period_end IS
  'ROSTER-SUPERSEDE.1 (mig 602) — the period the operator requested at publish time. period_end is shrunk to the days this roster actually owns; this is not.';

-- ============================================================
-- 2. Widen the status CHECK to include 'superseded'
-- ============================================================
-- Mig 072 wrote the check INLINE and unnamed (`check (status in ('draft',
-- 'published'))`), so Postgres auto-named it — `rosters_status_check` on a
-- normal box, but the name is an implementation detail and dropping the wrong
-- guess would leave the old constraint armed and every supersede rejected.
-- Drop by DEFINITION instead: any CHECK on this table whose definition
-- mentions `status`. `rosters_period_check` (period_end >= period_start)
-- does not, so it survives untouched.
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'public.rosters'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%status%'
  LOOP
    RAISE NOTICE 'mig 602: dropping status CHECK %', c.conname;
    EXECUTE format('ALTER TABLE public.rosters DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE public.rosters
  ADD CONSTRAINT rosters_status_check
  CHECK (status IN ('draft', 'published', 'superseded'));

-- ============================================================
-- 3. Backfill — IN THIS ORDER
-- ============================================================

-- 3a. Preserve the requested range before anything shrinks period_*.
--     Every existing row's period_* IS what was requested, so this is a
--     straight copy. Guarded by IS NULL so a re-run is a no-op.
UPDATE public.rosters
   SET requested_period_start = COALESCE(requested_period_start, period_start),
       requested_period_end   = COALESCE(requested_period_end, period_end)
 WHERE requested_period_start IS NULL
    OR requested_period_end IS NULL;

-- 3b. Supersede every published roster that owns ZERO blocks (58 rows on prod).
--     These are the rows a later publish already emptied; they are the whole
--     reason the overlap pairs in check (e) exist.
--
--     The successor pick is a correlated choice, not a guess dressed up as
--     one: among the published rosters at the SAME location that DO own
--     blocks, take the one whose OWNED day range overlaps this row's period,
--     preferring the one owning the most blocks (the roster that actually took
--     this period over), then the most recently published, then id for
--     determinism. `owned` is read as of statement start, so the rows being
--     superseded here cannot pick each other — they own no blocks and so are
--     not in `owned` at all.
--
--     NULL is an accepted outcome and must stay accepted: a period whose
--     successor was itself later emptied has no identifiable heir.
WITH owned AS (
  SELECT roster_id,
         count(*)         AS block_count,
         min(block_date)  AS owned_start,
         max(block_date)  AS owned_end
    FROM public.shift_blocks
   WHERE roster_id IS NOT NULL
   GROUP BY roster_id
),
zero_block_published AS (
  SELECT r.id
    FROM public.rosters r
    LEFT JOIN owned o ON o.roster_id = r.id
   WHERE r.status = 'published'
     AND o.roster_id IS NULL
)
UPDATE public.rosters r
   SET status        = 'superseded',
       superseded_at = now(),
       superseded_by = (
         SELECT s.id
           FROM public.rosters s
           JOIN owned so ON so.roster_id = s.id
          WHERE s.location_id = r.location_id
            AND s.id <> r.id
            AND s.status = 'published'
            AND daterange(so.owned_start, so.owned_end, '[]')
             && daterange(r.period_start, r.period_end, '[]')
          ORDER BY so.block_count DESC, s.published_at DESC NULLS LAST, s.id
          LIMIT 1
       )
  FROM zero_block_published z
 WHERE r.id = z.id;

-- 3c. Shrink every REMAINING published roster to the days it actually owns
--     (16 rows on prod; pre-apply check (c) says all 16 are contiguous, so
--     min/max re-claims nothing). requested_period_* is untouched — 3a ran
--     first precisely so this cannot lose the operator's original ask.
WITH owned AS (
  SELECT roster_id,
         min(block_date) AS owned_start,
         max(block_date) AS owned_end
    FROM public.shift_blocks
   WHERE roster_id IS NOT NULL
   GROUP BY roster_id
)
UPDATE public.rosters r
   SET period_start = o.owned_start,
       period_end   = o.owned_end
  FROM owned o
 WHERE o.roster_id = r.id
   AND r.status = 'published'
   AND (r.period_start <> o.owned_start OR r.period_end <> o.owned_end);

-- ============================================================
-- 4. Guard — refuse rather than half-apply
-- ============================================================
-- If the backfill did not actually resolve every overlap, the ADD CONSTRAINT
-- below would fail with a bare 23P01 naming two ids and nothing else, AFTER
-- the columns, the widened CHECK and the backfill had already landed. Abort
-- here instead, with the count and a pointer, so the file is all-or-nothing
-- as far as the operator is concerned.
DO $$
DECLARE bad integer;
BEGIN
  SELECT count(*) INTO bad
    FROM public.rosters a
    JOIN public.rosters b
      ON a.location_id = b.location_id
     AND a.id < b.id
   WHERE a.status = 'published'
     AND b.status = 'published'
     AND daterange(a.period_start, a.period_end, '[]')
      && daterange(b.period_start, b.period_end, '[]');

  IF bad > 0 THEN
    RAISE EXCEPTION
      'mig 602: % pair(s) of published rosters still overlap after the backfill; refusing to add rosters_no_overlapping_published. Two rosters genuinely own the same day - run pre-apply check (d) in this file''s header, decide which roster wins, and re-run.', bad;
  END IF;
END $$;

-- ============================================================
-- 5. The constraint
-- ============================================================
-- Partial on status='published': drafts awaiting approval may overlap freely
-- (they own no blocks until approved), and superseded rows are tombstones that
-- must be allowed to keep their historical period.
ALTER TABLE public.rosters
  DROP CONSTRAINT IF EXISTS rosters_no_overlapping_published;
ALTER TABLE public.rosters
  ADD CONSTRAINT rosters_no_overlapping_published
  EXCLUDE USING gist (
    location_id WITH =,
    daterange(period_start, period_end, '[]') WITH &&
  ) WHERE (status = 'published');

-- ============================================================
-- 6. FK index
-- ============================================================
-- Mig 108 indexes every FK on this table (created_by, published_by,
-- over_budget_approval_by); superseded_by is a new one, and its ON DELETE SET
-- NULL is exactly the seq-scan 108 exists to avoid.
CREATE INDEX IF NOT EXISTS idx_rosters_superseded_by ON public.rosters(superseded_by);
