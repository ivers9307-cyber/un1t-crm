-- ROSTER-FIX.4 — no two PUBLISHED rosters may cover the same day at the
-- same location. The app-level guard shipped in this PR
-- (src/app/api/schedule/rosters/route.js POST, 409 `overlapping_roster`);
-- this is the database backstop for the paths that don't go through it.
--
-- Why it matters: publishing rewrites shift_blocks.roster_id for every
-- block in the period, so a second overlapping roster silently takes over
-- the days it shares. The older roster row still claims those dates while
-- owning none of their blocks, and "which roster published this day"
-- (reports, findPublishedRosterFor, the approvals queue) stops having one
-- answer.
--
-- ⚠️ NOT APPLIED. Two things must be settled first:
--
-- 1. PRE-APPLY DATA CHECK — run read-only. It must return ZERO rows; every
--    row it returns is a pair of published rosters that already overlap and
--    would fail the ADD CONSTRAINT. Clean those by hand (delete the older,
--    now block-less roster) before applying:
--
--      SELECT a.id AS roster_a, a.period_start, a.period_end,
--             b.id AS roster_b, b.period_start, b.period_end
--        FROM public.rosters a
--        JOIN public.rosters b
--          ON a.location_id = b.location_id
--         AND a.id < b.id
--         AND a.status = 'published'
--         AND b.status = 'published'
--         AND daterange(a.period_start, a.period_end, '[]')
--          && daterange(b.period_start, b.period_end, '[]');
--
-- 2. 🔴 THE WIDENING FLOW CONFLICTS WITH THIS CONSTRAINT. The publish modal
--    documents "publish the week, then publish the whole month" — the app
--    guard deliberately allows a period that strictly CONTAINS an
--    already-published one, because the wider roster takes over every block
--    including the earlier week's. That leaves two overlapping rows, which
--    this constraint would reject at INSERT time, breaking a flow operators
--    use. Applying this file therefore requires deciding first what a
--    superset re-publish should do with the rosters it swallows (extend the
--    existing row's period, or delete the now-empty contained rows — both
--    lose or rewrite audit rows, so it is Richard's call). Until then the
--    app-level 409 is the only guard, and it is the narrower one on purpose.

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE public.rosters
  DROP CONSTRAINT IF EXISTS rosters_no_overlapping_published;
ALTER TABLE public.rosters
  ADD CONSTRAINT rosters_no_overlapping_published
  EXCLUDE USING gist (
    location_id WITH =,
    daterange(period_start, period_end, '[]') WITH &&
  ) WHERE (status = 'published');
