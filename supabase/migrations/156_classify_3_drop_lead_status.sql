-- ============================================================
-- 156: CLASSIFY.3 — drop contacts.lead_status
-- ============================================================
--
-- WHY THIS MIGRATION EXISTS
-- ─────────────────────────
-- CLASSIFY.1 (mig 155) denormalised pipeline_stage_slug onto contacts
-- so the audience builder could filter on the canonical funnel
-- position without joining through deals. CLASSIFY.2 (commit 2d9c966)
-- ripped every read+write of contacts.lead_status out of the web app
-- and api routes; this PR's mobile/ + shared/dashboard-data.js edits
-- finish the same pass for the React Native client. The only thing
-- left is the column itself plus a handful of dependent artefacts.
--
-- The lead_status column was effectively unmaintained — 99.9% of
-- Stillorgan contacts carried the import default 'active_trial' and
-- no code reliably wrote 'member' or other meaningful values back.
-- Keeping it around is now actively harmful: operators rebuilding
-- audiences keep reaching for "Lead Status = member" and getting
-- zero rows, and any new code touching the table has to remember
-- which of two columns to read.
--
-- WHAT THIS MIGRATION DOES (in order, single transaction)
-- ────────────────────────────────────────────────────────
--   1. Renames any email_sequences.trigger_type = 'status_change'
--      rows to 'pipeline_stage_change'. CLASSIFY.2 renamed the
--      trigger function in app code (triggerSequencesForStatusChange
--      → triggerSequencesForPipelineStageChange) and the trigger
--      now diffs on contacts.pipeline_stage_slug, but operator-
--      created sequence rows in the DB still carry the old string.
--      Without this rename those sequences silently stop firing.
--
--   2. Idempotent JSONB guards across four audience_filter columns
--      (campaigns, email_sequences, whatsapp_broadcasts,
--      sms_broadcasts) and sequence_steps.config — rewriting any
--      {"field":"lead_status"} predicate to
--      {"field":"pipeline_stage_slug"}. The current prod snapshot
--      has zero hits across all five tables (the AudienceBuilder
--      UI defaulted to pipeline_stage_slug from CLASSIFY.1 and
--      sequence step config validation rejected lead_status from
--      the whitelist in CLASSIFY.2), but the guard is here so any
--      stale row that slips through pre-deploy is rewritten rather
--      than orphaned.
--
--      NOTE on values: this only rewrites the *field name*, not the
--      value. lead_status used 'member' / 'lapsed_member';
--      pipeline_stage_slug uses 'active_member' / 'at_risk_member' /
--      'dormant'. If any row is actually rewritten by this guard, an
--      operator should re-open the audience and pick the right slug
--      from the new dropdown. RAISE NOTICE'd below for visibility.
--
--   3. Idempotent rewrite of email_sequences.goal_config
--      {"type":"lead_status"} → {"type":"pipeline_stage"}. The app
--      already aliases lead_status → pipeline_stage in
--      scheduler.isGoalMet via a console.warn, but the canonical
--      form is now pipeline_stage and there's no reason to keep the
--      alias firing once the column is gone.
--
--   4. Drops the two indexes on contacts.lead_status:
--        - idx_contacts_lead_status                  (plain btree)
--        - idx_contacts_location_lead_status         (partial btree
--          on (location_id, lead_status) WHERE lead_status IS NOT
--          NULL — replaced by idx_contacts_pipeline_stage_slug
--          which mig 155 added)
--
--   5. DROP COLUMN contacts.lead_status.
--
-- ROLLBACK
-- ────────
-- The column drop is irreversible without a restore. Before
-- merging this to prod, verify the Supabase preview branch run
-- shows step 5 succeeds and that mobile/ + shared/dashboard-data.js
-- on this branch reads pipeline_stage_slug everywhere it used to
-- read lead_status. Glofox-facing files (src/lib/glofox-*, src/app/
-- api/glofox/*, src/app/api/webhooks/glofox/*) intentionally keep
-- their `lead_status` references — those read from the Glofox API
-- payload (different field, uppercase enum), not from contacts.

BEGIN;

-- ============================================================
-- STEP 1 — rename sequence trigger_type
-- ============================================================

UPDATE email_sequences
SET    trigger_type = 'pipeline_stage_change'
WHERE  trigger_type = 'status_change';

-- ============================================================
-- STEP 2 — idempotent JSONB field-name rewrite
-- ============================================================
--
-- jsonb_set walks the `filters` array, swaps any element whose
-- `field` is 'lead_status' to 'pipeline_stage_slug', and leaves
-- everything else alone. WHERE clause limits the UPDATE to rows
-- that actually contain the old field so we don't touch every row.

DO $$
DECLARE
  n_campaigns   INT;
  n_sequences   INT;
  n_whatsapp    INT;
  n_sms         INT;
  n_steps       INT;
BEGIN
  UPDATE campaigns
  SET    audience_filter = jsonb_set(
           audience_filter,
           '{filters}',
           (SELECT jsonb_agg(CASE WHEN f->>'field' = 'lead_status'
                                  THEN jsonb_set(f, '{field}', '"pipeline_stage_slug"')
                                  ELSE f END)
              FROM jsonb_array_elements(audience_filter->'filters') f)
         )
  WHERE  audience_filter::text LIKE '%"lead_status"%'
    AND  audience_filter ? 'filters';
  GET DIAGNOSTICS n_campaigns = ROW_COUNT;

  UPDATE email_sequences
  SET    audience_filter = jsonb_set(
           audience_filter,
           '{filters}',
           (SELECT jsonb_agg(CASE WHEN f->>'field' = 'lead_status'
                                  THEN jsonb_set(f, '{field}', '"pipeline_stage_slug"')
                                  ELSE f END)
              FROM jsonb_array_elements(audience_filter->'filters') f)
         )
  WHERE  audience_filter::text LIKE '%"lead_status"%'
    AND  audience_filter ? 'filters';
  GET DIAGNOSTICS n_sequences = ROW_COUNT;

  UPDATE whatsapp_broadcasts
  SET    audience_filter = jsonb_set(
           audience_filter,
           '{filters}',
           (SELECT jsonb_agg(CASE WHEN f->>'field' = 'lead_status'
                                  THEN jsonb_set(f, '{field}', '"pipeline_stage_slug"')
                                  ELSE f END)
              FROM jsonb_array_elements(audience_filter->'filters') f)
         )
  WHERE  audience_filter::text LIKE '%"lead_status"%'
    AND  audience_filter ? 'filters';
  GET DIAGNOSTICS n_whatsapp = ROW_COUNT;

  UPDATE sms_broadcasts
  SET    audience_filter = jsonb_set(
           audience_filter,
           '{filters}',
           (SELECT jsonb_agg(CASE WHEN f->>'field' = 'lead_status'
                                  THEN jsonb_set(f, '{field}', '"pipeline_stage_slug"')
                                  ELSE f END)
              FROM jsonb_array_elements(audience_filter->'filters') f)
         )
  WHERE  audience_filter::text LIKE '%"lead_status"%'
    AND  audience_filter ? 'filters';
  GET DIAGNOSTICS n_sms = ROW_COUNT;

  UPDATE sequence_steps
  SET    config = jsonb_set(config, '{field}', '"pipeline_stage_slug"')
  WHERE  config->>'field' = 'lead_status';
  GET DIAGNOSTICS n_steps = ROW_COUNT;

  IF n_campaigns + n_sequences + n_whatsapp + n_sms + n_steps > 0 THEN
    RAISE NOTICE 'CLASSIFY.3: rewrote lead_status → pipeline_stage_slug in % campaigns / % sequences / % whatsapp / % sms / % sequence_steps. VALUES were NOT remapped; an operator should re-open each audience to pick the right slug (member→active_member, lapsed_member→at_risk_member, etc.).',
                 n_campaigns, n_sequences, n_whatsapp, n_sms, n_steps;
  END IF;
END $$;

-- ============================================================
-- STEP 3 — rewrite stale goal_config lead_status alias
-- ============================================================

UPDATE email_sequences
SET    goal_config = jsonb_set(goal_config, '{type}', '"pipeline_stage"')
WHERE  goal_config->>'type' = 'lead_status';

-- ============================================================
-- STEP 4 — drop the indexes that reference lead_status
-- ============================================================
--
-- Both must go before DROP COLUMN; idx_contacts_location_lead_status
-- was the partial index serving the pipeline page before mig 155
-- added idx_contacts_pipeline_stage_slug.

DROP INDEX IF EXISTS idx_contacts_lead_status;
DROP INDEX IF EXISTS idx_contacts_location_lead_status;

-- ============================================================
-- STEP 5 — DROP COLUMN
-- ============================================================

ALTER TABLE contacts DROP COLUMN IF EXISTS lead_status;

COMMIT;
