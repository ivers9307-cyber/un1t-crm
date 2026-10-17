-- 730 — UN1TCLASS.1: class_occurrences.source_platform — which platform a
-- projected class occurrence came from.
--
-- WHY. class_occurrences (mig 284, + cancelled_at mig 344) is the local class
-- spine the TV "Up next", Shelly class mode, the climate automations and the
-- studio scorecard read. Only Glofox filled it. Hatch Street runs on
-- un1t.online (UN1TSYNC.1, mig 726), so its timetable is projected into the
-- same table, and readers that need to know the origin (the scorecard's
-- "unavailable, never 0%" rule for no-show/attended on a platform that writes
-- no class_bookings) read this column.
--
-- VALUES. 'glofox' (every existing row, via the column default, so
-- syncOccurrencesForLocation needs no change) and 'un1t_online'. The CHECK is
-- the whole contract; a third platform is a new migration by design.
--
-- ID NAMESPACE. A un1t_online row's glofox_event_id is 'un1t:' || un1t_id.
-- The prefix cannot collide with a Glofox 24-hex id, which matters because
-- several readers look glofox_event_id up with no location filter
-- (credit-attendance, auto-end-stale-hr-sessions, the climate
-- automation_fire_log reads). No class_bookings rows are written for
-- un1t_online.
--
-- GRANT. None needed. class_occurrences is NOT column-granted (the column-grant
-- list in CLAUDE.md does not include it): authenticated holds table-level
-- SELECT through the location-scoped policy of mig 284, so the new column is
-- readable by the phone and browser the moment it exists, and a select naming
-- it cannot fail whole. No new client write: the table is written only by
-- service-role code.
--
-- One transaction with a 5s lock_timeout (ADD COLUMN … NOT NULL DEFAULT takes
-- ACCESS EXCLUSIVE on a table the TV and climate crons read). Re-runnable DDL.
-- The self-check reads the catalog, never this file's text, and aborts the
-- whole file.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.class_occurrences
  ADD COLUMN IF NOT EXISTS source_platform text NOT NULL DEFAULT 'glofox'
    CONSTRAINT class_occurrences_source_platform_check CHECK (source_platform IN ('glofox', 'un1t_online'));

COMMENT ON COLUMN public.class_occurrences.source_platform IS
  'UN1TCLASS.1 (mig 730) — glofox | un1t_online. Where the occurrence was projected from. un1t_online rows carry glofox_event_id = ''un1t:'' || un1t_events.un1t_id (the prefix cannot collide with a Glofox 24-hex id) and have NO class_bookings rows, so booking-derived metrics (no-show, attended) are unavailable for them, never zero.';

-- Refresh mig 726's table comment, which said the projection was not written.
COMMENT ON TABLE public.un1t_events IS
  'UN1TSYNC.1 (mig 726) / UN1TCLASS.1 (mig 730): un1t.online classes and events, projected into class_occurrences with source_platform = ''un1t_online'' and glofox_event_id = ''un1t:'' || un1t_id. NOT written to class_bookings. Service role only; the sync upserts and never deletes.';

-- ---------------------------------------------------------------------------
-- Self-check: the catalog, never this file's text (mig 153's lesson).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  col record;
  chk text;
BEGIN
  SELECT is_nullable, column_default, data_type INTO col
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'class_occurrences' AND column_name = 'source_platform';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'UN1TCLASS.1: class_occurrences.source_platform does not exist';
  END IF;
  IF col.data_type <> 'text' OR col.is_nullable <> 'NO' THEN
    RAISE EXCEPTION 'UN1TCLASS.1: source_platform must be text NOT NULL (got % / nullable=%)', col.data_type, col.is_nullable;
  END IF;
  IF col.column_default IS NULL OR col.column_default NOT LIKE '''glofox''%' THEN
    RAISE EXCEPTION 'UN1TCLASS.1: source_platform default must be ''glofox'' (got %)', col.column_default;
  END IF;

  SELECT pg_get_constraintdef(c.oid) INTO chk
    FROM pg_constraint c
   WHERE c.conrelid = 'public.class_occurrences'::regclass
     AND c.conname = 'class_occurrences_source_platform_check';
  IF chk IS NULL OR chk NOT LIKE '%glofox%' OR chk NOT LIKE '%un1t_online%' THEN
    RAISE EXCEPTION 'UN1TCLASS.1: the source_platform CHECK is missing or does not admit both values (got %)', chk;
  END IF;

  -- Readable by the phone with no grant line: table-level SELECT must still be there.
  IF NOT has_table_privilege('authenticated', 'public.class_occurrences', 'SELECT') THEN
    RAISE EXCEPTION 'UN1TCLASS.1: authenticated lost table-level SELECT on class_occurrences';
  END IF;
  IF has_column_privilege('anon', 'public.class_occurrences', 'source_platform', 'SELECT') THEN
    RAISE EXCEPTION 'UN1TCLASS.1: anon can read class_occurrences.source_platform';
  END IF;
  -- authenticated keeps a table-level UPDATE (mig 677 kept it), so the real
  -- write barrier is RLS: the only policy must be the SELECT one. A write
  -- policy appearing here would let a signed-in session rewrite the column.
  IF EXISTS (
    SELECT 1 FROM pg_policy
     WHERE polrelid = 'public.class_occurrences'::regclass
       AND polcmd IN ('a', 'w', 'd', '*')
  ) THEN
    RAISE EXCEPTION 'UN1TCLASS.1: class_occurrences has a write (INSERT/UPDATE/DELETE/ALL) policy; it must be service-role-write only';
  END IF;
  RAISE NOTICE 'UN1TCLASS.1 mig 730: class_occurrences.source_platform added.';
END $$;

COMMIT;
