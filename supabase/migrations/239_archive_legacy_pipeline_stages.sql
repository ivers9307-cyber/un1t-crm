-- ============================================================
-- 239: archive the dead pre-PIPELINE5 legacy pipeline stages
-- ============================================================
--
-- WHY
-- ───
-- The PIPELINE5 redesign (mig 147) introduced the canonical 9-slug
-- model the engagement classifier writes to:
--   new_lead, active_trial, hot_conversion, active_member,
--   at_risk_member, classpass_active, lapsed, dormant,
--   dormant_classpass
--
-- The original pre-PIPELINE5 stage set was left in place (not
-- archived) during cutover. The classifier never writes those old
-- slugs, so they carry ZERO deals — but `pipeline/page.js` only
-- filters `archived=false`, so they still render as empty columns
-- on the Kanban, cluttering the operator's board (18 visible
-- columns where the model has 9). The page comment already
-- anticipated this exact cleanup ("flipping archived=true on those
-- rows hides them").
--
-- Verified on prod (UN1T Stillorgan, 2026-06-02): each of the 9
-- legacy slugs below has 0 open and 0 non-open deals. `new_lead`
-- is deliberately NOT in the list — it is shared with the new
-- model and holds live deals.
--
-- WHAT
-- ────
-- Flip archived=true on the 9 legacy stages, guarded so a stage is
-- only archived when it has no open deal (belt-and-braces — should
-- be a no-op guard given the data, but protects against a stray
-- open deal at any location). Idempotent (re-running matches
-- nothing once archived). Reversible: UPDATE ... SET archived=false.

UPDATE pipeline_stages ps
SET    archived = true
WHERE  ps.archived = false
  AND  ps.slug IN (
         'new_lead_social',
         'trial_active',
         'conversion_ready',
         'follow_up_needed',
         'member',
         'cold_email_only',
         'lost_member',
         'returning_member',
         'credit_member'
       )
  AND  NOT EXISTS (
         SELECT 1 FROM deals d
         WHERE d.stage_id = ps.id
           AND d.status = 'open'
       );
