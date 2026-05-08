-- 116_achievements.sql
--
-- Phase 4 Slice A: data-driven achievements engine.
--
-- Why a rules table, not hardcoded enums
-- --------------------------------------
-- Staff need to add new badges without a code change ("we want a
-- '12-week consistency' badge for the new year challenge"). A rule
-- row stores the parameters, the engine in src/lib/achievements
-- looks at rule_type and dispatches to a typed detector. Adding a
-- new rule kind needs code; tweaking thresholds, names, icons, and
-- which class types qualify does NOT.
--
-- Two tables:
--   achievement_rules     definitions, edited by staff at /admin/achievements
--   contact_achievements  earned instances per (contact_id, rule_id)
--
-- rule_config jsonb shape varies by rule_type:
--   first_event           { event: 'session'|'z5_minute'|'class_type'|'location_visit',
--                            event_type_id?: uuid }
--   streak                { days: int, gap_tolerance_days?: int }
--   aggregate_threshold   { field: 'effort_points'|'classes'|'z3_minutes'|'z4_minutes'|
--                            'z5_minutes'|'total_minutes',
--                            period: 'week'|'month'|'year'|'all_time',
--                            threshold: int }
--   session_property      { predicate: 'all_zones_present'|'sustained_z5'|
--                            'new_personal_record',
--                            threshold?: int }
--   class_type_count      { event_type_id: uuid, count: int }
--   location_visit        { location_count: int }
--
-- "tier" exists so e.g. 5/10/25/50/100 classes are 5 separate rule
-- rows but render together as a single family in the UI. Bronze =
-- 1, Silver = 2, Gold = 3, Platinum = 4 by convention; staff can
-- override.

BEGIN;

-- ── achievement_rules ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.achievement_rules (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text NOT NULL UNIQUE,
  name          text NOT NULL,
  description   text,
  icon          text,                       -- lucide-react name or emoji
  category      text NOT NULL,              -- 'milestone' | 'streak' | 'volume' | 'class_type' | 'session_quality' | 'exploration'
  family        text,                       -- groups tiers together (e.g. 'classes_attended', 'weekly_points')
  tier          int NOT NULL DEFAULT 1,     -- 1 bronze … 4 platinum
  rule_type     text NOT NULL CHECK (rule_type IN (
                  'first_event','streak','aggregate_threshold',
                  'session_property','class_type_count','location_visit'
                )),
  rule_config   jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active     boolean NOT NULL DEFAULT true,
  sort_order    int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_achievement_rules_active_sort
  ON public.achievement_rules (is_active, sort_order);

CREATE INDEX IF NOT EXISTS idx_achievement_rules_family
  ON public.achievement_rules (family, tier);

-- updated_at trigger.
CREATE OR REPLACE FUNCTION public.touch_achievement_rules_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_achievement_rules_touch ON public.achievement_rules;
CREATE TRIGGER trg_achievement_rules_touch
  BEFORE UPDATE ON public.achievement_rules
  FOR EACH ROW EXECUTE FUNCTION public.touch_achievement_rules_updated_at();

-- ── contact_achievements ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.contact_achievements (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id          uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  rule_id             uuid NOT NULL REFERENCES public.achievement_rules(id) ON DELETE CASCADE,
  rule_slug           text NOT NULL,                     -- denorm so member UI can render even after a rule is renamed
  earned_at           timestamptz NOT NULL DEFAULT now(),
  source_session_id   uuid REFERENCES public.heart_rate_sessions(id) ON DELETE SET NULL,
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  notified_at         timestamptz,
  UNIQUE (contact_id, rule_id)
);

CREATE INDEX IF NOT EXISTS idx_contact_achievements_contact_earned
  ON public.contact_achievements (contact_id, earned_at DESC);

CREATE INDEX IF NOT EXISTS idx_contact_achievements_rule
  ON public.contact_achievements (rule_id, earned_at DESC);

-- "Just earned, not yet notified" — drives the push-notification cron.
CREATE INDEX IF NOT EXISTS idx_contact_achievements_pending_notify
  ON public.contact_achievements (earned_at DESC)
  WHERE notified_at IS NULL;

-- ── RLS ────────────────────────────────────────────────────────

ALTER TABLE public.achievement_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contact_achievements ENABLE ROW LEVEL SECURITY;

-- Rules: any signed-in user can read active rules (members render
-- locked-state badges from the catalog). Master-only for write.
CREATE POLICY "Anyone signed in reads active rules"
  ON public.achievement_rules FOR SELECT TO authenticated
  USING (is_active OR private.auth_is_master());

CREATE POLICY "Masters manage rules"
  ON public.achievement_rules FOR ALL TO authenticated
  USING (private.auth_is_master())
  WITH CHECK (private.auth_is_master());

-- Earned achievements: customer reads own, staff at the contact's
-- location reads. Insert/update is server-side only (no policy
-- needed — service role bypasses RLS).
CREATE POLICY "Customers read own achievements"
  ON public.contact_achievements FOR SELECT TO public
  USING (contact_id = private.auth_contact_id());

CREATE POLICY "Staff read achievements at their locations"
  ON public.contact_achievements FOR SELECT TO public
  USING (
    private.auth_is_master()
    OR EXISTS (
      SELECT 1 FROM public.contacts c
      WHERE c.id = contact_achievements.contact_id
        AND private.auth_is_in_location(c.location_id)
    )
  );

-- ── Seed v1 rules ──────────────────────────────────────────────
-- Slugs are stable identifiers; renaming `name` is fine, renaming
-- the slug breaks denormed contact_achievements.rule_slug rendering.

INSERT INTO public.achievement_rules
  (slug, name, description, icon, category, family, tier, rule_type, rule_config, sort_order) VALUES

-- Milestones (first_event)
('first_session',          'First class',           'You logged your first heart-rate session at UN1T.', 'Heart',     'milestone', 'first_session',  1, 'first_event',     '{"event":"session"}',     10),
('first_z5',               'Into the red',          'You spent at least one minute in Zone 5.',          'Flame',     'milestone', 'first_z5',       1, 'first_event',     '{"event":"z5_minute"}',   20),
('first_pr',               'First personal record', 'You set a new personal record for points in a class type.', 'Trophy', 'milestone','first_pr',1,'session_property','{"predicate":"new_personal_record"}',30),

-- Streaks
('streak_3',               '3-day streak',          'Three days in a row of UN1T.',     'Calendar',   'streak', 'streak', 1, 'streak',           '{"days":3}',  100),
('streak_7',               '7-day streak',          'A full week of consistency.',      'CalendarCheck','streak','streak',2,'streak',           '{"days":7}',  110),
('streak_14',              '14-day streak',         'Two weeks straight. Serious form.','CalendarRange','streak','streak',3,'streak',           '{"days":14}', 120),
('streak_30',              '30-day streak',         'A month without missing a day.',   'Award',      'streak', 'streak', 4, 'streak',          '{"days":30}', 130),

-- Volume — total classes
('classes_5',              '5 classes',             'You''ve logged 5 sessions.',                     'Activity',   'volume', 'classes_attended', 1, 'aggregate_threshold', '{"field":"classes","period":"all_time","threshold":5}',  200),
('classes_10',             '10 classes',            'You''ve logged 10 sessions.',                    'Activity',   'volume', 'classes_attended', 2, 'aggregate_threshold', '{"field":"classes","period":"all_time","threshold":10}', 210),
('classes_25',             '25 classes',            'You''ve logged 25 sessions.',                    'Activity',   'volume', 'classes_attended', 3, 'aggregate_threshold', '{"field":"classes","period":"all_time","threshold":25}', 220),
('classes_50',             '50 classes',            'You''ve logged 50 sessions — half a century.',   'Medal',      'volume', 'classes_attended', 4, 'aggregate_threshold', '{"field":"classes","period":"all_time","threshold":50}', 230),
('classes_100',            '100 classes',           'You''ve logged 100 sessions. Hall of fame.',     'Crown',      'volume', 'classes_attended', 4, 'aggregate_threshold', '{"field":"classes","period":"all_time","threshold":100}',240),

-- Volume — weekly points
('points_500_week',        '500 points in a week',  'You racked up 500 UN1T points in a single week.','Zap',        'volume', 'weekly_points', 1, 'aggregate_threshold', '{"field":"effort_points","period":"week","threshold":500}',  300),
('points_1000_week',       '1,000 points in a week','You racked up 1,000 UN1T points in a single week.','Zap',     'volume', 'weekly_points', 2, 'aggregate_threshold', '{"field":"effort_points","period":"week","threshold":1000}', 310),
('points_2500_week',       '2,500 points in a week','You racked up 2,500 UN1T points in a single week. That''s a hard week.','Zap','volume','weekly_points',3,'aggregate_threshold','{"field":"effort_points","period":"week","threshold":2500}',320),

-- Volume — high-zone hours all time
('z3plus_hours_10',        '10 high-effort hours',  '10 hours in Zone 3 or higher.',     'Timer',     'volume', 'z3plus_hours', 1, 'aggregate_threshold', '{"field":"z3plus_minutes","period":"all_time","threshold":600}',  400),
('z3plus_hours_25',        '25 high-effort hours',  '25 hours in Zone 3 or higher.',     'Timer',     'volume', 'z3plus_hours', 2, 'aggregate_threshold', '{"field":"z3plus_minutes","period":"all_time","threshold":1500}', 410),
('z3plus_hours_50',        '50 high-effort hours',  '50 hours in Zone 3 or higher.',     'Timer',     'volume', 'z3plus_hours', 3, 'aggregate_threshold', '{"field":"z3plus_minutes","period":"all_time","threshold":3000}', 420),
('z3plus_hours_100',       '100 high-effort hours', '100 hours in Zone 3 or higher.',    'Timer',     'volume', 'z3plus_hours', 4, 'aggregate_threshold', '{"field":"z3plus_minutes","period":"all_time","threshold":6000}', 430),

-- Session quality
('all_zones_one_session',  'Full spectrum',         'You hit all five zones in a single session.',    'Rainbow',    'session_quality', 'session_spectrum', 1, 'session_property',  '{"predicate":"all_zones_present"}', 500),
('sustained_z5_5min',      '5 minutes red-lining',  'Sustained at least 5 minutes in Zone 5 in a single session.','Flame','session_quality','sustained_z5',1,'session_property','{"predicate":"sustained_z5","threshold":300}',510),

-- Exploration
('locations_2',            'Two studios',           'You''ve trained at 2 different UN1T studios.',   'MapPin',     'exploration', 'locations_visited', 1, 'location_visit', '{"location_count":2}', 600),
('locations_3',            'Three studios',         'You''ve trained at 3 different UN1T studios.',   'MapPin',     'exploration', 'locations_visited', 2, 'location_visit', '{"location_count":3}', 610),
('locations_5',            'Studio explorer',       'You''ve trained at 5 different UN1T studios.',   'MapPin',     'exploration', 'locations_visited', 3, 'location_visit', '{"location_count":5}', 620)
;

COMMIT;
