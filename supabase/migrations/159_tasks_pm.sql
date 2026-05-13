-- ============================================================
-- 159: TASKS.1 — extend activities into a lightweight PM tool
-- ============================================================
--
-- WHY THIS MIGRATION EXISTS
-- ─────────────────────────
-- The Tasks tab (/activities filtered by kind='task') has been
-- shipped but unused — 0 task rows exist, all 9,536 rows in
-- `activities` are auto-logged kind='event' bookings / SMS / WA.
-- The only entry point was the contact-detail page's Add Activity
-- form. Operator wants the tab to work standalone (no contact
-- required) and grow PM-style fields: who's the assignee, what's
-- the priority, what's the status beyond a binary done flag.
--
-- WHAT THIS MIGRATION DOES
-- ────────────────────────
--   1. Adds assignee_id (FK profiles), priority (low / medium /
--      high / urgent), status (todo / in_progress / done /
--      cancelled), project (free-text tag), completed_at.
--   2. Backfills status from the legacy `done` boolean:
--        done=true  → status='done'
--        done=false → status='todo'
--      for kind='task' rows (the only ones the new fields apply
--      to). Auto-logged kind='event' rows leave status null so
--      they don't appear as 'todo' on any board.
--   3. Trigger to keep `done` in sync with `status` going forward
--      — the existing UI + ActivityToggle still write `done`, the
--      new kanban + list views write `status`. Trigger makes both
--      converge on insert/update.
--   4. Indexes for the assignee / status / project queries the
--      new filters + kanban use.

BEGIN;

-- ============================================================
-- STEP 1 — new columns
-- ============================================================

ALTER TABLE activities
  ADD COLUMN IF NOT EXISTS assignee_id  UUID REFERENCES profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS priority     TEXT CHECK (priority IN ('low','medium','high','urgent')),
  ADD COLUMN IF NOT EXISTS status       TEXT CHECK (status   IN ('todo','in_progress','done','cancelled')),
  ADD COLUMN IF NOT EXISTS project      TEXT,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

COMMENT ON COLUMN activities.assignee_id IS
  'TASKS.1 — staff member responsible for this task. Nullable: unassigned tasks are valid.';
COMMENT ON COLUMN activities.priority IS
  'TASKS.1 — operator-set priority. Nullable: unprioritised tasks default to "none" in the UI.';
COMMENT ON COLUMN activities.status IS
  'TASKS.1 — kanban-column membership. Source of truth going forward; the legacy "done" boolean is maintained by trigger for backward-compat with the old ActivityToggle UI.';
COMMENT ON COLUMN activities.project IS
  'TASKS.1 — free-text project tag (e.g. "marketing", "ops"). No referential integrity; the kanban groups by this column when set.';
COMMENT ON COLUMN activities.completed_at IS
  'TASKS.1 — set by the trigger when status transitions INTO done. Used for "tasks completed this week" cohorts.';

-- ============================================================
-- STEP 2 — backfill status from the legacy done flag
-- ============================================================
--
-- Only applies to kind='task' rows. kind='event' rows are auto-
-- logged history (a booking happened, an SMS was sent) — they
-- aren't on the kanban and shouldn't carry a status.

UPDATE activities
SET status = CASE WHEN done = TRUE THEN 'done' ELSE 'todo' END
WHERE kind = 'task'
  AND status IS NULL;

UPDATE activities
SET completed_at = updated_at
WHERE kind = 'task'
  AND done = TRUE
  AND completed_at IS NULL;

-- ============================================================
-- STEP 3 — done <-> status sync trigger
-- ============================================================
--
-- Belt-and-braces both directions:
--   - If the caller writes status, derive done from it.
--   - If the caller writes done (existing ActivityToggle), derive
--     a sensible status (toggling done → status='done', toggling
--     undone → status='todo') but only for kind='task' rows.
-- Either way, completed_at gets stamped on first transition INTO
-- done and cleared on transition OUT of done.

CREATE OR REPLACE FUNCTION sync_activity_done_status()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Only synchronise for tasks. Events keep their existing
  -- done/null behaviour.
  IF NEW.kind <> 'task' THEN
    RETURN NEW;
  END IF;

  -- 1. status was set (or changed) — derive done.
  IF NEW.status IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
    NEW.done := (NEW.status = 'done');
    -- Stamp completed_at on transition INTO done, clear it leaving done.
    IF NEW.status = 'done' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'done') THEN
      NEW.completed_at := COALESCE(NEW.completed_at, NOW());
    ELSIF NEW.status <> 'done' THEN
      NEW.completed_at := NULL;
    END IF;
    RETURN NEW;
  END IF;

  -- 2. done was flipped without status being touched (ActivityToggle).
  IF (TG_OP = 'UPDATE' AND OLD.done IS DISTINCT FROM NEW.done) THEN
    NEW.status := CASE WHEN NEW.done = TRUE THEN 'done' ELSE 'todo' END;
    IF NEW.done = TRUE THEN
      NEW.completed_at := COALESCE(NEW.completed_at, NOW());
    ELSE
      NEW.completed_at := NULL;
    END IF;
    RETURN NEW;
  END IF;

  -- 3. INSERT with neither field set — default status='todo' for
  --    tasks created via legacy code paths that only set done=false.
  IF TG_OP = 'INSERT' AND NEW.status IS NULL THEN
    NEW.status := CASE WHEN NEW.done = TRUE THEN 'done' ELSE 'todo' END;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS activities_done_status_sync ON activities;
CREATE TRIGGER activities_done_status_sync
  BEFORE INSERT OR UPDATE OF status, done ON activities
  FOR EACH ROW
  EXECUTE FUNCTION sync_activity_done_status();

-- ============================================================
-- STEP 4 — indexes for the new query paths
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_activities_task_assignee_status
  ON activities (location_id, assignee_id, status)
  WHERE kind = 'task';

CREATE INDEX IF NOT EXISTS idx_activities_task_project
  ON activities (location_id, project)
  WHERE kind = 'task' AND project IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_activities_task_due_status
  ON activities (location_id, status, due_date)
  WHERE kind = 'task';

COMMIT;
