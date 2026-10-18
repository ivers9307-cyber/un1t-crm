-- HATCHPIPE.3 — migration A2: re-enable UN1T Hatch Street's acquisition board,
-- now classified from un1t.online inputs (board module `acquisition_un1t`).
-- Spec A §6.8 (docs/superpowers/specs/2026-10-17-hatch-pipeline-and-invoices-design.md).
--
-- 🔴 APPLY ONLY AFTER PR 2 (#2098, the `acquisition_un1t` module, the un1t
-- pipelineInputs seam and the orchestrator) HAS DEPLOYED, and after mig 736
-- (A1, the own-studio slug rule). On a deploy without the module the row is
-- "no board module registered" and skipped, never classified from `contacts`.
--
-- DATA ONLY, Hatch only, one transaction:
--   * Hatch's `pipelines` row key='acquisition' becomes enabled=true,
--     is_primary=false, mode='derived', module='acquisition_un1t',
--     display_order=1. The waitlist board stays Hatch's enabled primary at 0.
--   * The 11 stages of shared/pipelines/acquisition.js are upserted at Hatch
--     (`on conflict (location_id, slug)`, conflict-targeted: mig 559's lesson)
--     with archived=false and pipeline_id = Hatch acquisition; name,
--     display_order, colour and is_dormant come from the module (the test
--     reads the module and fails if this list drifts from it). The other 7
--     archived legacy stage rows on that board (PIPELINE5's 200-block) stay
--     archived.
--   * No deal and no contact is written. The board's deals are created by the
--     first classification run (hourly after a good un1t-online-sync, and the
--     nightly cron), not here.
--
-- MEASURED ON THE LIVE DB, 18 Oct 2026 (read-only, before this file):
--   * Hatch acquisition row: module 'acquisition', mode derived, enabled
--     false, is_primary false, display_order 0. Waitlist row: module null,
--     mode manual, enabled true, is_primary true, display_order 0.
--   * 18 archived acquisition stage rows at Hatch, including all 11 module
--     slugs; 5 unarchived waitlist stages.
--   * Open waitlist deals at Hatch: 159 (= every open Hatch deal).
--   * "Later effect" (spec §6.6, checked AFTER the first run, not here): 62
--     Hatch-owned contacts linked in un1t_clients at Hatch with no open
--     waitlist deal. After the first run each of them should carry an
--     acquisition slug; every other contact's slug is unchanged.
--   * Active email_sequences at Hatch: 0. Scheduled campaigns at Hatch: 0.
--     Enabled location_automations at Hatch: 0. Active pipeline_stage_change
--     sequences anywhere: 0. So nothing stage-filtered can fire on the
--     first run's slug changes.
--
-- IDEMPOTENT: every write sets a value, so a second run changes nothing and
-- passes the same self-checks (some repo guard tests replay migrations).
--
-- SELF-CHECKS are POST-STATE invariants (the mig 739 shape), so a replay on
-- later data still passes. The waitlist count is checked as "unchanged by this
-- migration" (captured at the start of the transaction, compared at the end),
-- not as `= 159`: the board's first run, and every waitlist lead after today,
-- moves the live count, and an equality on the constant would make any replay
-- raise. 159 is the number to see when it is applied. Any check failing raises
-- and rolls the whole transaction back:
--   1. Hatch acquisition row is exactly the target state above;
--   2. exactly one enabled primary at Hatch, and it is the waitlist;
--   3. Hatch acquisition holds exactly 11 unarchived stages, each matching the
--      module row for its slug (the 7 legacy rows stayed archived);
--   4. Hatch's open waitlist deal count is unchanged;
--   5. no deal and no contact row changed (so no pipeline_stage_slug moved);
--   6. every pipelines row and every pipeline_stages row this migration does
--      not target is unchanged (no other location, no waitlist row, no legacy
--      stage was touched).
--
-- grant: none (no new relation)

BEGIN;

DO $$
DECLARE
  v_hatch          constant uuid := '28c78d6b-f7b3-4edf-8c7c-840bd047b3f4';  -- UN1T Hatch Street
  v_acq            uuid;
  v_waitlist_open  int;
  v_deals_hash     text;
  v_contacts_hash  text;
  v_others_hash    text;
  v_after          int;
  v_n              int;
BEGIN
  SELECT id INTO v_acq FROM public.pipelines
   WHERE location_id = v_hatch AND key = 'acquisition';
  IF v_acq IS NULL THEN
    RAISE EXCEPTION 'HATCHPIPE.3: Hatch has no acquisition pipelines row';
  END IF;

  -- The 11 stages of shared/pipelines/acquisition.js, verbatim.
  CREATE TEMP TABLE a2_module_stages (
    slug text PRIMARY KEY, name text NOT NULL, display_order int NOT NULL,
    color text NOT NULL, is_dormant boolean NOT NULL
  ) ON COMMIT DROP;
  INSERT INTO a2_module_stages (slug, name, display_order, color, is_dormant) VALUES
    ('new_lead',     'New Leads',  301, '#3B82F6', false),
    ('first_class',  '1st Class',  302, '#10B981', false),
    ('second_class', '2nd Class',  303, '#14B8A6', false),
    ('trial_done',   'Trial Done', 304, '#F59E0B', false),
    ('converted',    'Converted',  305, '#059669', false),
    ('member',       'Member',     306, '#64748B', true),
    ('pack_member',  'Class Pack', 307, '#0891B2', true),
    ('classpass',    'ClassPass',  308, '#A855F7', true),
    ('dormant',      'Dormant',    309, '#6B7280', true),
    ('cold_lead',    'Cold',       310, '#52525B', true),
    ('gympass',      'Gympass',    311, '#F97316', true);

  -- ── Before: what must not move ────────────────────────────────────────────
  SELECT count(*) INTO v_waitlist_open
    FROM public.deals d
    JOIN public.pipelines p ON p.id = d.pipeline_id
   WHERE p.location_id = v_hatch AND p.key = 'waitlist' AND d.status = 'open';

  SELECT md5(coalesce(string_agg(concat_ws('|', id, stage_id, pipeline_id, status, updated_at), ',' ORDER BY id), ''))
    INTO v_deals_hash FROM public.deals;
  SELECT md5(coalesce(string_agg(concat_ws('|', id, pipeline_stage_slug, updated_at), ',' ORDER BY id), ''))
    INTO v_contacts_hash FROM public.contacts;
  SELECT md5(
           (SELECT coalesce(string_agg(row_to_json(p)::text, ',' ORDER BY p.id), '')
              FROM public.pipelines p WHERE p.id <> v_acq)
           || '#' ||
           (SELECT coalesce(string_agg(row_to_json(s)::text, ',' ORDER BY s.id), '')
              FROM public.pipeline_stages s
             WHERE NOT (s.location_id = v_hatch AND s.slug IN (SELECT slug FROM a2_module_stages))))
    INTO v_others_hash;

  -- ── Writes ────────────────────────────────────────────────────────────────
  -- The board row. is_primary stays false, so pipelines_one_primary_per_location
  -- (one primary per location) is never in play.
  UPDATE public.pipelines
     SET enabled = true, is_primary = false, mode = 'derived',
         module = 'acquisition_un1t', display_order = 1
   WHERE id = v_acq AND location_id = v_hatch;

  -- The 11 stages, conflict-targeted on the slug so a collision on anything
  -- else (a name already taken on the board) raises instead of vanishing.
  INSERT INTO public.pipeline_stages
    (location_id, pipeline_id, name, slug, display_order, color, is_dormant, archived)
  SELECT v_hatch, v_acq, m.name, m.slug, m.display_order, m.color, m.is_dormant, false
    FROM a2_module_stages m
  ON CONFLICT (location_id, slug) DO UPDATE
     SET pipeline_id   = EXCLUDED.pipeline_id,
         name          = EXCLUDED.name,
         display_order = EXCLUDED.display_order,
         color         = EXCLUDED.color,
         is_dormant    = EXCLUDED.is_dormant,
         archived      = false;

  -- ── After: post-state invariants ──────────────────────────────────────────
  -- 1. The board row.
  IF NOT EXISTS (
    SELECT 1 FROM public.pipelines
     WHERE id = v_acq AND location_id = v_hatch AND key = 'acquisition'
       AND enabled AND NOT is_primary AND mode = 'derived'
       AND module = 'acquisition_un1t' AND display_order = 1
  ) THEN
    RAISE EXCEPTION 'HATCHPIPE.3: Hatch acquisition row is not enabled/derived/acquisition_un1t/non-primary/order 1';
  END IF;

  -- 2. Waitlist is the one enabled primary.
  SELECT count(*) INTO v_n FROM public.pipelines
   WHERE location_id = v_hatch AND enabled AND is_primary;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'HATCHPIPE.3: Hatch has % enabled primary boards, expected exactly 1', v_n;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.pipelines
     WHERE location_id = v_hatch AND key = 'waitlist' AND enabled AND is_primary
  ) THEN
    RAISE EXCEPTION 'HATCHPIPE.3: the waitlist board is not Hatch''s enabled primary';
  END IF;

  -- 3. Exactly the module's 11 stages are live on the board, each as declared.
  SELECT count(*) INTO v_n FROM public.pipeline_stages
   WHERE pipeline_id = v_acq AND NOT archived;
  IF v_n <> 11 THEN
    RAISE EXCEPTION 'HATCHPIPE.3: Hatch acquisition has % live stages, expected 11', v_n;
  END IF;
  SELECT count(*) INTO v_n
    FROM a2_module_stages m
    JOIN public.pipeline_stages s
      ON s.location_id = v_hatch AND s.slug = m.slug
     AND s.pipeline_id = v_acq AND NOT s.archived
     AND s.name = m.name AND s.display_order = m.display_order
     AND s.color = m.color AND s.is_dormant = m.is_dormant;
  IF v_n <> 11 THEN
    RAISE EXCEPTION 'HATCHPIPE.3: only % of the 11 module stages are live as declared on Hatch acquisition', v_n;
  END IF;

  -- 4. The waitlist's open deals (159 when measured) are unchanged.
  SELECT count(*) INTO v_after
    FROM public.deals d
    JOIN public.pipelines p ON p.id = d.pipeline_id
   WHERE p.location_id = v_hatch AND p.key = 'waitlist' AND d.status = 'open';
  IF v_after <> v_waitlist_open THEN
    RAISE EXCEPTION 'HATCHPIPE.3: Hatch open waitlist deals moved from % to %', v_waitlist_open, v_after;
  END IF;

  -- 5. No deal and no contact written.
  IF (SELECT md5(coalesce(string_agg(concat_ws('|', id, stage_id, pipeline_id, status, updated_at), ',' ORDER BY id), ''))
        FROM public.deals) IS DISTINCT FROM v_deals_hash THEN
    RAISE EXCEPTION 'HATCHPIPE.3: a deals row changed; this migration writes no deals';
  END IF;
  IF (SELECT md5(coalesce(string_agg(concat_ws('|', id, pipeline_stage_slug, updated_at), ',' ORDER BY id), ''))
        FROM public.contacts) IS DISTINCT FROM v_contacts_hash THEN
    RAISE EXCEPTION 'HATCHPIPE.3: a contacts row changed; this migration writes no contacts';
  END IF;

  -- 6. Nothing else touched: other locations, the waitlist, the legacy stages.
  IF (SELECT md5(
            (SELECT coalesce(string_agg(row_to_json(p)::text, ',' ORDER BY p.id), '')
               FROM public.pipelines p WHERE p.id <> v_acq)
            || '#' ||
            (SELECT coalesce(string_agg(row_to_json(s)::text, ',' ORDER BY s.id), '')
               FROM public.pipeline_stages s
              WHERE NOT (s.location_id = v_hatch AND s.slug IN (SELECT slug FROM a2_module_stages)))))
     IS DISTINCT FROM v_others_hash THEN
    RAISE EXCEPTION 'HATCHPIPE.3: a pipelines or pipeline_stages row outside Hatch acquisition''s 11 stages changed';
  END IF;

  DROP TABLE a2_module_stages;
END
$$;

COMMIT;
