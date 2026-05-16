-- ============================================================
-- 162: PERF.1 — Supabase performance advisor cleanup
-- ============================================================
--
-- WHY THIS MIGRATION EXISTS
-- ─────────────────────────
-- The Supabase perf advisor flagged five categories of issue
-- against the prod DB. This migration ships the four high-impact
-- ones; the fifth (237 unused indexes) is left for a separate
-- audit since "unused since stats reset" is not the same as
-- "safe to drop".
--
-- Categories tackled here:
--
--   (1) `auth_rls_initplan` — 8 policies call auth.uid() raw,
--       which makes Postgres re-evaluate it per row instead of
--       once per query. Wrapping in (SELECT auth.uid()) turns
--       it into an InitPlan and lets PG cache the result.
--
--   (2) `unindexed_foreign_keys` — 11 single-column FK columns
--       had no covering index. That makes the planner do a seq
--       scan for `... JOIN parent ON child.fk = parent.id` and
--       for ON DELETE CASCADE cleanup. All 11 tables are small
--       today, but indexes are cheap to add now and painful to
--       add later under contention.
--
--   (3) `multiple_permissive_policies` — 6 redundant policies:
--         • cron_heartbeats_no_anon / _no_authenticated: both
--           are PERMISSIVE with qual=false, which is functionally
--           identical to having no policy at all (RLS denies by
--           default). They were also forcing PG to evaluate two
--           policies per query on a hot path (campaign cron).
--         • "Service role full access" on event_type_reminders /
--           rosters / shift_assignments / shift_blocks: each had
--           qual=true and roles=public, which silently granted
--           every database role (anon included) full access on
--           those tables. service_role bypasses RLS by default,
--           so the policy was a security smell on top of a perf
--           cost. Dropping is safe — the in-location + manager
--           policies remain in place for authenticated users.
--
--   (4) `duplicate_index` — 13 indexes where a non-unique twin
--       sat alongside the unique constraint that covered the
--       same columns. The advisor flagged 19 candidates; on
--       review 6 of them are partial indexes serving a separate
--       query (e.g. WHERE email_marketing = true) and were left
--       in place. Each drop here is the strict subset / non-
--       unique sibling of an index we're keeping.
--
-- All operations are in a single transaction. Largest affected
-- table is `activities` at ~9.5k rows / 2 MB, so plain CREATE
-- INDEX is fine — no CONCURRENTLY needed.

BEGIN;

-- ============================================================
-- (1) Wrap auth.uid() in policies so it evaluates once per query
-- ============================================================
-- For each: DROP + CREATE with identical semantics, only the
-- auth.uid() call wrapped in (SELECT ...).

-- glofox_invoices
DROP POLICY IF EXISTS "glofox_invoices_select" ON public.glofox_invoices;
CREATE POLICY "glofox_invoices_select" ON public.glofox_invoices
  FOR SELECT
  USING (
    location_id IN (
      SELECT pl.location_id
      FROM public.profile_locations pl
      WHERE pl.profile_id = (SELECT auth.uid())
    )
  );

-- glofox_push_events
DROP POLICY IF EXISTS "glofox_push_events_select" ON public.glofox_push_events;
CREATE POLICY "glofox_push_events_select" ON public.glofox_push_events
  FOR SELECT
  USING (
    location_id IN (
      SELECT pl.location_id
      FROM public.profile_locations pl
      WHERE pl.profile_id = (SELECT auth.uid())
    )
  );

-- glofox_sync_runs
DROP POLICY IF EXISTS "glofox_sync_runs_select" ON public.glofox_sync_runs;
CREATE POLICY "glofox_sync_runs_select" ON public.glofox_sync_runs
  FOR SELECT
  USING (
    location_id IN (
      SELECT pl.location_id
      FROM public.profile_locations pl
      WHERE pl.profile_id = (SELECT auth.uid())
    )
  );

-- landing_page_settings (master-or-owner ALL)
DROP POLICY IF EXISTS "landing_page_settings_master_owner_write"
  ON public.landing_page_settings;
CREATE POLICY "landing_page_settings_master_owner_write"
  ON public.landing_page_settings
  FOR ALL
  TO authenticated
  USING (
    private.auth_is_master()
    OR EXISTS (
      SELECT 1
      FROM public.profile_locations pl
      WHERE pl.profile_id = (SELECT auth.uid())
        AND pl.location_id = landing_page_settings.location_id
        AND pl.role = 'owner'
    )
  )
  WITH CHECK (
    private.auth_is_master()
    OR EXISTS (
      SELECT 1
      FROM public.profile_locations pl
      WHERE pl.profile_id = (SELECT auth.uid())
        AND pl.location_id = landing_page_settings.location_id
        AND pl.role = 'owner'
    )
  );

-- pipeline_classification_runs
DROP POLICY IF EXISTS "pipeline_classification_runs_select"
  ON public.pipeline_classification_runs;
CREATE POLICY "pipeline_classification_runs_select"
  ON public.pipeline_classification_runs
  FOR SELECT
  USING (
    location_id IN (
      SELECT pl.location_id
      FROM public.profile_locations pl
      WHERE pl.profile_id = (SELECT auth.uid())
    )
  );

-- profile_compensation INSERT
DROP POLICY IF EXISTS "profile_compensation_insert" ON public.profile_compensation;
CREATE POLICY "profile_compensation_insert" ON public.profile_compensation
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (SELECT auth.uid()) AND p.role = 'master'
    )
    OR EXISTS (
      SELECT 1
      FROM public.profile_locations caller_pl
      JOIN public.profile_locations target_pl
        ON target_pl.location_id = caller_pl.location_id
      WHERE caller_pl.profile_id = (SELECT auth.uid())
        AND caller_pl.role = 'owner'
        AND target_pl.profile_id = profile_compensation.profile_id
    )
  );

-- profile_compensation SELECT
DROP POLICY IF EXISTS "profile_compensation_select" ON public.profile_compensation;
CREATE POLICY "profile_compensation_select" ON public.profile_compensation
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (SELECT auth.uid()) AND p.role = 'master'
    )
    OR EXISTS (
      SELECT 1
      FROM public.profile_locations caller_pl
      JOIN public.profile_locations target_pl
        ON target_pl.location_id = caller_pl.location_id
      WHERE caller_pl.profile_id = (SELECT auth.uid())
        AND caller_pl.role = 'owner'
        AND target_pl.profile_id = profile_compensation.profile_id
    )
  );

-- profile_compensation UPDATE
DROP POLICY IF EXISTS "profile_compensation_update" ON public.profile_compensation;
CREATE POLICY "profile_compensation_update" ON public.profile_compensation
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (SELECT auth.uid()) AND p.role = 'master'
    )
    OR EXISTS (
      SELECT 1
      FROM public.profile_locations caller_pl
      JOIN public.profile_locations target_pl
        ON target_pl.location_id = caller_pl.location_id
      WHERE caller_pl.profile_id = (SELECT auth.uid())
        AND caller_pl.role = 'owner'
        AND target_pl.profile_id = profile_compensation.profile_id
    )
  );


-- ============================================================
-- (2) FK covering indexes
-- ============================================================
-- All 11 are single-column FKs with no covering index. plain
-- CREATE INDEX (small tables; CONCURRENTLY not needed and would
-- prevent running inside this txn).

CREATE INDEX IF NOT EXISTS idx_activities_assignee_id
  ON public.activities (assignee_id)
  WHERE assignee_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_contact_achievements_source_session_id
  ON public.contact_achievements (source_session_id)
  WHERE source_session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_glofox_push_events_reviewed_by
  ON public.glofox_push_events (reviewed_by)
  WHERE reviewed_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_landing_page_settings_updated_by
  ON public.landing_page_settings (updated_by);

CREATE INDEX IF NOT EXISTS idx_password_overrides_audit_location_id
  ON public.password_overrides_audit (location_id);

CREATE INDEX IF NOT EXISTS idx_password_overrides_audit_target_contact_id
  ON public.password_overrides_audit (target_contact_id)
  WHERE target_contact_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_password_overrides_audit_target_profile_id
  ON public.password_overrides_audit (target_profile_id)
  WHERE target_profile_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pipeline_classification_runs_created_by
  ON public.pipeline_classification_runs (created_by);

CREATE INDEX IF NOT EXISTS idx_profile_compensation_updated_by
  ON public.profile_compensation (updated_by);

CREATE INDEX IF NOT EXISTS idx_strap_assignments_booking_id
  ON public.strap_assignments (booking_id)
  WHERE booking_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tv_content_pushed_by
  ON public.tv_content (pushed_by);


-- ============================================================
-- (3) Drop redundant policies
-- ============================================================
-- cron_heartbeats: two PERMISSIVE policies with qual=false are
-- equivalent to no policy at all (RLS enabled, no policy =>
-- deny). service_role bypasses RLS so the cron path is unaffected.
DROP POLICY IF EXISTS "cron_heartbeats_no_anon" ON public.cron_heartbeats;
DROP POLICY IF EXISTS "cron_heartbeats_no_authenticated" ON public.cron_heartbeats;

-- "Service role full access" with qual=true + roles=public was
-- granting every db role (anon, authenticated, service_role) full
-- access. service_role bypasses RLS anyway, so the policy was both
-- a security smell and a per-query perf hit (second permissive
-- policy evaluated alongside the in-location ones).
DROP POLICY IF EXISTS "Service role full access" ON public.event_type_reminders;
DROP POLICY IF EXISTS "Service role full access" ON public.rosters;
DROP POLICY IF EXISTS "Service role full access" ON public.shift_assignments;
DROP POLICY IF EXISTS "Service role full access" ON public.shift_blocks;


-- ============================================================
-- (4) Drop duplicate indexes
-- ============================================================
-- Each dropped index is a strict subset / non-unique sibling of a
-- unique constraint we're keeping (or a strictly tighter partial
-- whose superset is staying). 6 other "duplicate" pairs the
-- advisor flagged were genuinely serving different queries
-- (different partial WHERE) and have been kept.

-- cars: keep unique; drop partial NOT-NULL twin
DROP INDEX IF EXISTS public.idx_cars_deposit_token_lookup;

-- company_settings: keep unique; drop non-unique twin
DROP INDEX IF EXISTS public.idx_company_settings_location;

-- contact_preferences: two pairs
DROP INDEX IF EXISTS public.idx_contact_prefs_contact;
DROP INDEX IF EXISTS public.idx_contact_prefs_token;

-- contacts: keep partial unique; drop full-column twin
DROP INDEX IF EXISTS public.idx_contacts_email;
-- contacts: keep partial NOT-NULL; drop full-column twin
DROP INDEX IF EXISTS public.idx_contacts_glofox_id;

-- event_types: keep unique
DROP INDEX IF EXISTS public.idx_event_types_slug;

-- location_holidays: keep unique
DROP INDEX IF EXISTS public.idx_location_holidays_location_date;

-- orders: keep unique
DROP INDEX IF EXISTS public.idx_orders_source;

-- race_waves: keep unique
DROP INDEX IF EXISTS public.idx_race_waves_event;

-- tv_displays: keep unique
DROP INDEX IF EXISTS public.idx_tv_displays_token;

-- sequence_enrollments: the full unique on (sequence_id, contact_id)
-- already forbids any second row, so the partial unique scoped to
-- status='active' is redundant.
DROP INDEX IF EXISTS public.sequence_enrollments_unique_active;

-- sequence_enrollments: due_idx is a strict subset of next_step
-- (extra NOT NULL clause; equality/range queries on next_step_at
-- implicitly exclude NULLs anyway).
DROP INDEX IF EXISTS public.sequence_enrollments_due_idx;

COMMIT;
