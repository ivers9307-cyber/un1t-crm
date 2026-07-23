-- 440: HYROX-TC.1 — Hyrox Training Club. Two tables:
--   hyrox_blocks   — one AI-designed 12-week periodised arc per location/intake.
--   hyrox_sessions — each planned session under a block (coach-facing detail +
--                    TV board + review status). Maps to a real HYROX class at
--                    publish time by location_id + week_no + slot (weekday), NOT
--                    by glofox_event_id (which Glofox re-mints per attempt).
-- RLS mirrors class_occurrences (mig 284): authenticated SELECT for own
-- locations; all writes are service-role.

BEGIN;

CREATE TABLE IF NOT EXISTS public.hyrox_blocks (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id        uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  title              text,
  starts_on          date NOT NULL,                 -- week 1 Monday (Dublin calendar date)
  weeks              int  NOT NULL DEFAULT 12,
  sessions_per_week  int  NOT NULL DEFAULT 2,        -- Stillorgan runs 2/week
  session_weekdays   smallint[] NOT NULL,            -- ISO weekday per slot (Mon=1..Sun=7); Stillorgan {3,7}
  difficulty_dial    text NOT NULL DEFAULT 'mixed'
    CHECK (difficulty_dial IN ('beginner_heavy','mixed','competitive')),
  auto_tune_enabled  boolean NOT NULL DEFAULT false, -- §8.3 toggle: when true, the auto-tune signal feeds generation (signal computation is Phase 2)
  arc                jsonb NOT NULL DEFAULT '{}'::jsonb,
  status             text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','archived')),
  generated_by       text,                           -- model id + prompt version for provenance
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hyrox_blocks_loc_active
  ON public.hyrox_blocks (location_id, status);

CREATE TABLE IF NOT EXISTS public.hyrox_sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  block_id       uuid NOT NULL REFERENCES public.hyrox_blocks(id) ON DELETE CASCADE,
  location_id    uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE, -- denormalised for RLS/scoping
  week_no        int  NOT NULL,
  slot           int  NOT NULL,
  phase          text NOT NULL CHECK (phase IN ('base','build','peak','taper')),
  focus          text,
  is_benchmark   boolean NOT NULL DEFAULT false,
  full_session   jsonb NOT NULL DEFAULT '{}'::jsonb,  -- coach-facing: warmup/strength/main/finisher/cues/why
  board          jsonb NOT NULL DEFAULT '{}'::jsonb,  -- TV-facing: title/format/cap/stations(per-tier)/target
  status         text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','approved','published')),
  approved_by    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  approved_at    timestamptz,
  published_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hyrox_sessions_unique UNIQUE (block_id, week_no, slot)
);

CREATE INDEX IF NOT EXISTS idx_hyrox_sessions_loc_status
  ON public.hyrox_sessions (location_id, status);

ALTER TABLE public.hyrox_blocks   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hyrox_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "hyrox_blocks_location_scoped_select" ON public.hyrox_blocks;
CREATE POLICY "hyrox_blocks_location_scoped_select" ON public.hyrox_blocks
  FOR SELECT TO authenticated
  USING (private.auth_is_in_location(location_id));

DROP POLICY IF EXISTS "hyrox_sessions_location_scoped_select" ON public.hyrox_sessions;
CREATE POLICY "hyrox_sessions_location_scoped_select" ON public.hyrox_sessions
  FOR SELECT TO authenticated
  USING (private.auth_is_in_location(location_id));

COMMENT ON TABLE public.hyrox_blocks IS
  'Hyrox Training Club 12-week periodised arc per location/intake (HYROX-TC.1, mig 440). arc holds the AI-designed weekly phase/stimulus map. Writes service-role only.';
COMMENT ON TABLE public.hyrox_sessions IS
  'Planned Hyrox sessions under a block (HYROX-TC.1, mig 440). full_session = coach-facing; board = TV-facing. Maps to a HYROX class by location_id + week_no + slot. Writes service-role only.';

COMMIT;
