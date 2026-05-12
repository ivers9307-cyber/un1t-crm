-- PIPELINE5.1 — new pipeline stage taxonomy.
--
-- Why: post-Glofox-bulk-import the Kanban showed 8,133 deals
-- distributed across stages that were a 1:1 map of Glofox status.
-- That mapping had no engagement-recency filter, so the pipeline
-- was full of historical ghosts (trials from 4 years ago, "members"
-- who hadn't booked anything since 2022, ClassPass users from
-- pre-2023). See PIPELINE5 task chain for the diagnosis.
--
-- New taxonomy is engagement-aware:
--   New Lead         — recently joined, no attendance yet
--   Active Trial     — currently on trial AND recent activity
--   Hot Conversion   — ≥2 classes in 7d OR ≤1 credit left
--   Active Member    — paying member with recent activity
--   At Risk Member   — member status BUT 30-90d silent (proactive save)
--   ClassPass Active — classpass_payg WITH attendance in last 30d
--   Lapsed           — was active in last 6mo, now 60-180d idle
--   Dormant          — 180+ days idle, non-ClassPass
--   Dormant ClassPass— ClassPass user not attended in last 30d
--
-- This migration ONLY adds the new stages. Existing deals continue
-- to reference the OLD stage_ids (cold_email_only, trial_active,
-- member, conversion_ready, etc.) until PIPELINE5.7 runs the
-- one-shot backfill that moves every deal to the new taxonomy via
-- the classifier. Until then, the Kanban shows BOTH sets — old
-- stages remain functional, new ones are empty.
--
-- A follow-up cleanup migration (post 5.7) will archive + drop the
-- old slugs once we've verified the backfill landed correctly.
--
-- Schema additions:
--   pipeline_stages.archived BOOLEAN DEFAULT false
--     — soft-delete flag for the cleanup migration. Not used yet
--       (no rows are archived in 5.1). Added now so the Kanban can
--       start filtering on it when we're ready.
--   pipeline_stages.is_dormant BOOLEAN DEFAULT false
--     — hides the stage from the default Kanban view. Operator can
--       still open a "Dormant" tab to see + target them. Set to
--       true for the two dormant stages below.

ALTER TABLE pipeline_stages
  ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE pipeline_stages
  ADD COLUMN IF NOT EXISTS is_dormant BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN pipeline_stages.archived IS
  'PIPELINE5.1: soft-delete. Archived stages are hidden from all UI but stay referenced by historical deals. Cleanup migration drops these once backfill (5.7) has moved every deal off them.';
COMMENT ON COLUMN pipeline_stages.is_dormant IS
  'PIPELINE5.1: hides from the default Kanban view. Operator opens a separate "Dormant" tab to access. Set on dormant + dormant_classpass.';

-- Insert new stages for every existing location. The display_order
-- is set in the 200+ range so they sort AFTER the existing stages
-- temporarily. PIPELINE5.7 cleanup will renumber to 1..9 once the
-- old stages are archived.
INSERT INTO pipeline_stages (location_id, slug, name, display_order, color, is_dormant)
SELECT l.id, v.slug, v.name, v.display_order, v.color, v.is_dormant
FROM locations l
CROSS JOIN (VALUES
  -- (slug,                name,                  display_order, color,     is_dormant)
  ('active_trial',         'Active Trial',         201, '#10B981', false),
  ('hot_conversion',       'Hot Conversion',       202, '#F59E0B', false),
  ('active_member',        'Active Member',        203, '#059669', false),
  ('at_risk_member',       'At Risk Member',       204, '#EAB308', false),
  ('classpass_active',     'ClassPass Active',     205, '#A855F7', false),
  ('lapsed',               'Lapsed',               206, '#EF4444', false),
  ('dormant',              'Dormant',              207, '#6B7280', true),
  ('dormant_classpass',    'Dormant — ClassPass',  208, '#94A3B8', true)
) AS v(slug, name, display_order, color, is_dormant)
ON CONFLICT (slug) DO NOTHING;

-- Sanity: confirm every location now has the full new set. If a
-- new location was added without these stages, the next pipeline-
-- classify run for a contact at that location would fail to find
-- a target stage_id.
DO $$
DECLARE
  missing_count INT;
BEGIN
  SELECT count(*) INTO missing_count
  FROM locations l
  CROSS JOIN (VALUES
    ('active_trial'), ('hot_conversion'), ('active_member'),
    ('at_risk_member'), ('classpass_active'), ('lapsed'),
    ('dormant'), ('dormant_classpass')
  ) AS needed(slug)
  LEFT JOIN pipeline_stages ps ON ps.location_id = l.id AND ps.slug = needed.slug
  WHERE ps.id IS NULL;

  IF missing_count > 0 THEN
    RAISE NOTICE 'PIPELINE5.1: % stage rows missing across locations — inspect manually', missing_count;
  END IF;
END $$;
