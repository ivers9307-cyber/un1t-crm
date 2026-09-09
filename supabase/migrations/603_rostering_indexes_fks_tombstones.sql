-- 603 — ROSTER-FIX.8a: rostering indexes, the two FKs the roster surface lost
-- along the way, and the cancelled-assignment tombstones PR 1 left behind.
--
-- Four independent changes, deliberately in one file because change 4 is only
-- safe AFTER change 3 (see its section).
--
-- ─────────────────────────────────────────────────────────────────────────
-- PRE-APPLY CHECKS (run read-only BEFORE applying this file)
-- ─────────────────────────────────────────────────────────────────────────
--
-- (a) schedule_notifications rows whose shift_id points at nothing. These are
--     nulled by section 2 before the FK goes back on — the count is how many
--     notification rows lose their (already dangling) reference:
--
--       SELECT count(*) FROM public.schedule_notifications sn
--        WHERE sn.shift_id IS NOT NULL
--          AND NOT EXISTS (SELECT 1 FROM public.shift_assignments a
--                           WHERE a.id = sn.shift_id);
--     Expected: any number. Non-zero is expected — mig 238 dropped the FK and
--     the column has been a free reference id since. Note the number; it is
--     how many rows section 2 changes.
--
-- (b) The FK shapes this file rewrites. Read them off the live box rather than
--     trusting mig 237 — a name that differs makes the ALTERs below fail:
--
--       SELECT conname, confdeltype,
--              pg_get_constraintdef(oid) AS def
--         FROM pg_constraint
--        WHERE conrelid = 'public.shift_swap_requests'::regclass
--          AND contype = 'f'
--        ORDER BY conname;
--     Expected exactly (mig 237):
--       shift_swap_requests_requester_shift_id_fkey  confdeltype 'c' (CASCADE)
--       shift_swap_requests_target_shift_id_fkey     confdeltype 'n' (SET NULL)
--     If requester_shift_id already reads 'n', section 3 is already applied and
--     is a no-op; if the name differs, fix the name here before applying.
--
--       SELECT conname FROM pg_constraint
--        WHERE conrelid = 'public.schedule_notifications'::regclass
--          AND contype = 'f';
--     Expected: no constraint on shift_id (mig 238 dropped it).
--
-- (c) Tombstones. Section 4 DELETEs every one of them, so know the number
--     first, and know what it takes with it:
--
--       SELECT count(*) FROM public.shift_assignments WHERE status = 'cancelled';
--     Expected: a small number of PRE-ROSTER-FIX.1 rows. Every reader already
--     ignores them (PR 1) and approved drops now DELETE rather than tombstone,
--     so nothing in the product reads these.
--
--       SELECT count(*) FROM public.shift_swap_requests s
--         JOIN public.shift_assignments a ON a.id = s.requester_shift_id
--        WHERE a.status = 'cancelled';
--     Expected: any number. Each of these swap HISTORY rows keeps its row and
--     loses only the pointer (requester_shift_id → NULL), which is the whole
--     point of section 3 landing first. Before section 3 the same DELETE would
--     have CASCADED these swap rows out of existence.
--
--       SELECT s.id, s.status, s.location_id
--         FROM public.shift_swap_requests s
--         JOIN public.shift_assignments a ON a.id = s.requester_shift_id
--        WHERE a.status = 'cancelled'
--          AND s.status IN ('pending', 'awaiting_approval');
--     🔴 Expected: ZERO rows. A row here is an OPEN swap on a shift that no
--     longer exists — after this file it would be an open swap pointing at
--     nothing, which the approve path cannot finalise. Cancel those swaps by
--     hand (status = 'cancelled') BEFORE applying.
--
--       SELECT b.location_id, a.block_id, a.profile_id
--         FROM public.shift_assignments a
--         JOIN public.shift_blocks b ON b.id = a.block_id
--        WHERE a.status = 'cancelled'
--          AND EXISTS (SELECT 1 FROM public.shift_assignments live
--                       WHERE live.block_id = a.block_id
--                         AND live.profile_id = a.profile_id
--                         AND live.status <> 'cancelled');
--     Expected: zero rows — the (block_id, profile_id) unique key makes a live
--     row and a tombstone for the same pair impossible. This is here as a
--     sanity check on the unique key itself, not as a blocker.
--
-- AFTER APPLYING: get_advisors (type=security) — expect no new warning.

-- ============================================================
-- 1. Indexes
-- ============================================================
-- shift_assignments already has single-column indexes on block_id and
-- profile_id (mig 067). The composite is for the read this surface actually
-- does most: "this coach's assignments", then narrowed to a block — payroll,
-- the personal dashboard, the overlap guard in mig 604, and the swap routes
-- all lead with profile_id.
CREATE INDEX IF NOT EXISTS shift_assignments_profile_block_idx
  ON public.shift_assignments (profile_id, block_id);

-- time_off_requests had no index at all beyond its primary key, and both of
-- these are hot: the leave-overlap check reads one profile's requests by date
-- range, and the manager queue reads a location's pending requests from a
-- start date.
CREATE INDEX IF NOT EXISTS time_off_requests_profile_dates_idx
  ON public.time_off_requests (profile_id, start_date, end_date);

CREATE INDEX IF NOT EXISTS time_off_requests_location_status_start_idx
  ON public.time_off_requests (location_id, status, start_date);

-- ============================================================
-- 2. schedule_notifications.shift_id — restore the FK
-- ============================================================
-- Mig 010 gave the column a FK to the legacy public.shifts; mig 238 dropped
-- both the table and the constraint and left the column as "a free reference
-- id". It has been holding shift_assignments.id ever since, unpoliced — so a
-- deleted assignment (which ROSTER-FIX.1's approved-drop path now does
-- routinely) leaves a notification row pointing at an id that resolves to
-- nothing. Point it at the table it actually references.
--
-- ON DELETE SET NULL, not CASCADE: the notification is a record that someone
-- was told something. Losing the shift it referred to must not erase the fact
-- that the message was sent.
UPDATE public.schedule_notifications
   SET shift_id = NULL
 WHERE shift_id IS NOT NULL
   AND shift_id NOT IN (SELECT id FROM public.shift_assignments);

ALTER TABLE public.schedule_notifications
  DROP CONSTRAINT IF EXISTS schedule_notifications_shift_id_fkey;
ALTER TABLE public.schedule_notifications
  ADD CONSTRAINT schedule_notifications_shift_id_fkey
  FOREIGN KEY (shift_id) REFERENCES public.shift_assignments(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.schedule_notifications.shift_id IS
  'shift_assignments.id of a representative shift in the notification. FK restored in mig 603 (ROSTER-FIX.8a) as ON DELETE SET NULL — the record that a notification was sent outlives the shift it was about.';

-- ============================================================
-- 3. shift_swap_requests.requester_shift_id — CASCADE → SET NULL
-- ============================================================
-- Mig 237 repointed this FK onto shift_assignments with ON DELETE CASCADE,
-- which was harmless while an approved drop TOMBSTONED the assignment. D4
-- (ROSTER-FIX.1) changed that: an approved drop DELETEs the assignment, so the
-- cascade takes the approved swap row with it and the only record that a coach
-- asked to drop a shift, and that a manager approved it, is destroyed at the
-- moment it becomes true.
--
-- SET NULL keeps the history row. The column has to become nullable for that,
-- which is also why mig 599's partial unique index is safe here: NULLs are
-- distinct in a btree unique index, so any number of dropped-shift history
-- rows can coexist.
ALTER TABLE public.shift_swap_requests
  ALTER COLUMN requester_shift_id DROP NOT NULL;

ALTER TABLE public.shift_swap_requests
  DROP CONSTRAINT IF EXISTS shift_swap_requests_requester_shift_id_fkey;
ALTER TABLE public.shift_swap_requests
  ADD CONSTRAINT shift_swap_requests_requester_shift_id_fkey
  FOREIGN KEY (requester_shift_id) REFERENCES public.shift_assignments(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.shift_swap_requests.requester_shift_id IS
  'shift_assignments.id the requester wanted to give away. NULLABLE + ON DELETE SET NULL since mig 603 (ROSTER-FIX.8a): an approved drop deletes the assignment and this row must survive it as history. NULL therefore means "the shift this swap was about is gone", not "no shift was named" — a swap is never created without one.';

-- ============================================================
-- 4. Tombstone cleanup — MUST come after section 3
-- ============================================================
-- ROSTER-FIX.1 settled D4: `status = 'cancelled'` is not a state the roster
-- has any more. Every reader ignores it (isLiveAssignment) and approved drops
-- DELETE. But the rows written before that still sit on disk, and the
-- (block_id, profile_id) unique key from mig 067 means a tombstone BLOCKS
-- re-adding that coach to that block — a manager trying to put a coach back on
-- a shift they once dropped gets a 23505 and no explanation. Clear them.
--
-- Order is load-bearing: run this DELETE before section 3 and the old CASCADE
-- takes every swap row that referenced a tombstone with it, silently deleting
-- the history section 3 exists to preserve. After section 3 the same rows are
-- simply detached (requester_shift_id → NULL).
DELETE FROM public.shift_assignments WHERE status = 'cancelled';
