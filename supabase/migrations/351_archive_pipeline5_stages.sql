-- FUNNEL.2 — archive the retired PIPELINE5 stages. Apply ONLY after the
-- post-deploy reclassify commit run (docs/superpowers/plans/
-- 2026-07-02-pipeline-acquisition-funnel.md, Task 10) — the guard below
-- refuses to run while any open deal still sits on a retired stage.

-- 0. Ensure every location has the off-funnel 'dormant' catch-all the
--    FUNNEL.1 classifier depends on. Already applied to production as
--    ad-hoc DML during the mig 350 rollout (SourceIt + Test Studio were
--    provisioned before dormant existed and never got one); repeated
--    here idempotently so any restored/branched environment converges.
INSERT INTO pipeline_stages (location_id, name, slug, display_order, color, archived, is_dormant)
SELECT l.id, 'Dormant', 'dormant', 308, '#6B7280', false, true
FROM locations l
WHERE NOT EXISTS (
  SELECT 1 FROM pipeline_stages ps
  WHERE ps.location_id = l.id AND ps.slug = 'dormant' AND ps.archived = false
);

-- 1. Guard: refuse while any open deal still points at a retired stage.
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n
    FROM deals d JOIN pipeline_stages ps ON ps.id = d.stage_id
   WHERE d.status = 'open'
     AND ps.slug IN ('active_trial','hot_conversion','active_member',
                     'at_risk_member','classpass_active','lapsed','dormant_classpass');
  IF n > 0 THEN
    RAISE EXCEPTION 'FUNNEL.2: % open deals still on PIPELINE5 stages — run the pipeline reclassify commit first', n;
  END IF;
END $$;

-- 2. Archive. Rows stay on disk (deals FK history; forward-only rule).
UPDATE pipeline_stages SET archived = true
 WHERE slug IN ('active_trial','hot_conversion','active_member',
                'at_risk_member','classpass_active','lapsed','dormant_classpass');
