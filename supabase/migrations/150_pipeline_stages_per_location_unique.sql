-- PIPELINE5.8c — fix global UNIQUE on pipeline_stages.slug + name.
--
-- mig 001 created these as global UNIQUE back when the system was
-- single-tenant. After the multi-tenant migration (079) we should
-- have moved to (location_id, slug) but never did — and PIPELINE5.1
-- (mig 147) inserted new stages via CROSS JOIN with
-- ON CONFLICT (slug) DO NOTHING, which silently inserted each new
-- slug only ONCE — for whatever location PostgreSQL evaluated first.
--
-- Result on 2026-05-12:
--   CCF Autos          → got all 8 PIPELINE5.x stages
--   UN1T Stillorgan    → got NONE (still on the old 10-stage set)
--   UN1T Hatch Street  → has 0 stages at all
--
-- Operator hit this when running the 5.7 backfill: 899 of 1000
-- contacts errored because the classifier returned slugs like
-- 'dormant' / 'active_member' that didn't exist for their location.
--
-- Fix: drop the global UNIQUE constraints, replace with per-location
-- compound UNIQUE, then re-insert the full PIPELINE5.x stage set
-- across every active location with ON CONFLICT (location_id, slug)
-- DO NOTHING so re-runs are safe.

ALTER TABLE pipeline_stages DROP CONSTRAINT IF EXISTS pipeline_stages_slug_key;
ALTER TABLE pipeline_stages DROP CONSTRAINT IF EXISTS pipeline_stages_name_key;

ALTER TABLE pipeline_stages
  ADD CONSTRAINT pipeline_stages_location_slug_unique UNIQUE (location_id, slug);
ALTER TABLE pipeline_stages
  ADD CONSTRAINT pipeline_stages_location_name_unique UNIQUE (location_id, name);

-- Re-run the PIPELINE5.1 insert with the corrected ON CONFLICT
-- target. Includes 'new_lead' this time (mig 147 omitted it on the
-- assumption it pre-existed everywhere — only true for Stillorgan).
INSERT INTO pipeline_stages (location_id, slug, name, display_order, color, is_dormant)
SELECT l.id, v.slug, v.name, v.display_order, v.color, v.is_dormant
FROM locations l
CROSS JOIN (VALUES
  ('new_lead',           'New Lead',             200, '#3B82F6', false),
  ('active_trial',       'Active Trial',         201, '#10B981', false),
  ('hot_conversion',     'Hot Conversion',       202, '#F59E0B', false),
  ('active_member',      'Active Member',        203, '#059669', false),
  ('at_risk_member',     'At Risk Member',       204, '#EAB308', false),
  ('classpass_active',   'ClassPass Active',     205, '#A855F7', false),
  ('lapsed',             'Lapsed',               206, '#EF4444', false),
  ('dormant',            'Dormant',              207, '#6B7280', true),
  ('dormant_classpass',  'Dormant - ClassPass',  208, '#94A3B8', true)
) AS v(slug, name, display_order, color, is_dormant)
WHERE l.active = true
ON CONFLICT (location_id, slug) DO NOTHING;

-- Sanity check: every active location should now have all 9 stages.
DO $$
DECLARE
  missing_count INT;
BEGIN
  SELECT count(*) INTO missing_count
  FROM locations l
  CROSS JOIN (VALUES
    ('new_lead'), ('active_trial'), ('hot_conversion'), ('active_member'),
    ('at_risk_member'), ('classpass_active'), ('lapsed'),
    ('dormant'), ('dormant_classpass')
  ) AS needed(slug)
  LEFT JOIN pipeline_stages ps ON ps.location_id = l.id AND ps.slug = needed.slug
  WHERE l.active = true AND ps.id IS NULL;

  IF missing_count > 0 THEN
    RAISE EXCEPTION 'PIPELINE5.8c: % stage rows still missing across active locations', missing_count;
  END IF;
END $$;
