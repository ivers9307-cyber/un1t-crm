-- FUNNEL.1 — acquisition-funnel pipeline redesign (operator-approved 2026-07-02).
-- Design doc: docs/superpowers/plans/2026-07-02-pipeline-acquisition-funnel.md
--
-- Adds contacts.converted_at + the new funnel stage rows + retargets the
-- one draft sequence that referenced the old taxonomy. The 7 retired
-- PIPELINE5 stages are archived LATER (mig 344), after the new classifier
-- has moved every deal — deploy order: this migration → code → reclassify
-- commit → mig 344.

-- 1. Conversion moment. Write-once, stamped by applyMemberSync when
--    glofox_membership_status transitions into member/credit_member
--    (webhook path = near-instant; nightly sync = catch-all).
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS converted_at timestamptz;
COMMENT ON COLUMN contacts.converted_at IS
  'FUNNEL.1 — first observed transition into member/credit_member. Drives the pipeline Converted column (60d window). Seeded from joined_at for members who joined within 60d of mig 343; accurate from webhook stamping onward.';

-- 2. Launch-cohort seed. joined_at is a proxy for the conversion moment
--    (~15 contacts at Stillorgan on 2026-07-02). NOT accurate for members
--    who existed as leads long before joining — accepted by operator.
UPDATE contacts
   SET converted_at = joined_at
 WHERE converted_at IS NULL
   AND glofox_membership_status IN ('member', 'credit_member')
   AND joined_at > now() - interval '60 days';

-- 3. Revive Stillorgan's ARCHIVED legacy 'member' stage row (mig 239
--    archived it) as the new off-funnel Member bucket, so the slug isn't
--    duplicated. Other locations get a fresh row from the INSERT below.
UPDATE pipeline_stages
   SET archived = false, is_dormant = true, name = 'Member',
       display_order = 306, color = '#64748B'
 WHERE slug = 'member';

-- 4. New funnel stages for every location (mig 147 CROSS JOIN pattern).
--    display_order 301+ sorts after the PIPELINE5 200-block until mig 344
--    archives that block. is_dormant=true = "Off funnel" tab (hidden from
--    the default board view; the existing view switcher mechanism).
INSERT INTO pipeline_stages (location_id, name, slug, display_order, color, archived, is_dormant)
SELECT l.id, s.name, s.slug, s.display_order, s.color, false, s.is_dormant
FROM locations l
CROSS JOIN (VALUES
  ('1st Class',  'first_class',  302, '#10B981', false),
  ('2nd Class',  'second_class', 303, '#14B8A6', false),
  ('Trial Done', 'trial_done',   304, '#F59E0B', false),
  ('Converted',  'converted',    305, '#059669', false),
  ('Member',     'member',       306, '#64748B', true),
  ('ClassPass',  'classpass',    307, '#A855F7', true)
) AS s(name, slug, display_order, color, is_dormant)
WHERE NOT EXISTS (
  SELECT 1 FROM pipeline_stages ps
  WHERE ps.location_id = l.id AND ps.slug = s.slug
);

-- 5. Re-slot the two REUSED stages into the funnel ordering.
--    new_lead: column 1 (semantics tighten to "joined ≤60d, 0 attended"
--    in the new classifier). dormant: off-funnel catch-all, unchanged.
UPDATE pipeline_stages SET name = 'New Leads', display_order = 301
 WHERE slug = 'new_lead' AND archived = false;
UPDATE pipeline_stages SET display_order = 308
 WHERE slug = 'dormant' AND archived = false;

-- 6. Retarget stored sequence configs that reference retired stage
--    semantics. Verified 2026-07-02: exactly one draft sequence has
--    trigger_config to_status='member' ("New member welcome") — its
--    intent maps to the new 'converted' stage (fires the moment the
--    conversion move happens, not 60d later when converted → member).
UPDATE email_sequences
   SET trigger_config = jsonb_set(trigger_config, '{to_status}', '"converted"')
 WHERE trigger_type = 'pipeline_stage_change'
   AND trigger_config->>'to_status' = 'member';
UPDATE email_sequences
   SET goal_config = jsonb_set(goal_config, '{value}', '"converted"')
 WHERE goal_config->>'type' = 'pipeline_stage'
   AND goal_config->>'value' IN ('active_member', 'member');
UPDATE email_sequences
   SET goal_config = jsonb_set(goal_config, '{value}', '"first_class"')
 WHERE goal_config->>'type' = 'pipeline_stage'
   AND goal_config->>'value' = 'active_trial';
