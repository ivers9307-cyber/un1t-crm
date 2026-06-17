-- 287: HR-CLASS-ALLOC.1 — link heart-rate sessions to the Glofox class they
-- happened in. Foundation for "HR + people synced to a class": the bridge
-- ingest + the coach manual-pair now stamp the class occurrence (from the
-- class_occurrences spine) onto each session at creation. Presence-based for
-- now (class_link_source='presence' = "this class was running at the
-- location/time"); the 'booked' refinement (a per-member Glofox check)
-- follows. glofox_event_id is a soft reference to
-- class_occurrences.glofox_event_id; class_name is a snapshot so the link
-- survives any future occurrence pruning.
ALTER TABLE public.heart_rate_sessions
  ADD COLUMN IF NOT EXISTS glofox_event_id   text,
  ADD COLUMN IF NOT EXISTS class_name        text,
  ADD COLUMN IF NOT EXISTS class_link_source text
    CHECK (class_link_source IN ('booked', 'presence'));

CREATE INDEX IF NOT EXISTS idx_hr_sessions_glofox_event
  ON public.heart_rate_sessions (glofox_event_id) WHERE glofox_event_id IS NOT NULL;

COMMENT ON COLUMN public.heart_rate_sessions.glofox_event_id IS
  'HR-CLASS-ALLOC.1 (mig 287): the Glofox class occurrence this session happened in (soft ref to class_occurrences.glofox_event_id). class_name is a snapshot; class_link_source = booked|presence.';
