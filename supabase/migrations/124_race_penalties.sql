-- ============================================================
-- 124: race_penalties — operator-applied time adjustments
--
-- Adds a new table to capture per-team penalty time during
-- live race-day operation (Hyrox / OCR style — "missed 5 reps
-- on burpees: +30s"). One row per applied penalty so the audit
-- trail is preserved and individual penalties can be removed
-- (operator undo) without losing the others.
--
-- Per Richard's spec: tracked SEPARATELY rather than as a single
-- summed column, so each penalty carries its own reason + actor.
-- The race-day UI sums them client-side for display; the schema
-- doesn't materialise a total (no triggers), keeping inserts
-- cheap and avoiding cache-invalidation bugs.
--
-- Signed seconds — operator can apply a +30s penalty OR a -10s
-- credit (rare, but useful when correcting a bad timer call
-- in the team's favour). DEFAULT 0 isn't useful for inserts
-- since the operator always picks an amount, but it's defensive
-- against a bad client.
--
-- RLS mirrors race_registrations: read + write for staff at the
-- race's location (joined through race_event), or master.
-- Service-role inserts (none today) bypass.
--
-- Race-only by design — workshops / seminars / etc. don't have
-- timing semantics so they can't accumulate penalties. The PATCH
-- /api/registrations/[id]/penalties handler gates on
-- race_events.kind='race' (matches the E7 pattern from the
-- events expansion).
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.race_penalties (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  race_registration_id   UUID NOT NULL REFERENCES public.race_registrations(id) ON DELETE CASCADE,

  -- Signed: + adds time (penalty), - subtracts time (credit). Bounded
  -- defensively at ±2h so a typo can't make a team's elapsed time
  -- nonsense (the longest plausible penalty is single minutes).
  seconds                INT NOT NULL DEFAULT 0
    CHECK (seconds BETWEEN -7200 AND 7200),

  -- Free-text reason ("missed 5 reps on burpees", "false start",
  -- etc). Required so the audit trail is meaningful — operator
  -- has to type something even if just "manual adjustment".
  reason                 TEXT NOT NULL CHECK (length(trim(reason)) > 0 AND length(reason) <= 500),

  -- Who applied it. Nullable on profile delete so we don't lose
  -- the penalty itself when an old operator's profile is removed.
  applied_by             UUID REFERENCES public.profiles(id) ON DELETE SET NULL,

  applied_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.race_penalties IS
  'Operator-applied time adjustments for a race_registration. Signed seconds: + = penalty, - = credit. Multiple penalties per team — UI sums client-side. Race-only (gated at the API layer on race_events.kind=''race''). Mig 124.';

COMMENT ON COLUMN public.race_penalties.seconds IS
  'Signed integer. Positive = penalty added to elapsed time, negative = credit subtracted. Bounded ±2h defensively.';

COMMENT ON COLUMN public.race_penalties.reason IS
  'Operator-entered description. Required (NOT NULL + length>0). Surfaced in the manage-penalties list under each team in the race-day control panel.';

-- Powers the per-team SUM lookup the control board needs every
-- 2s polling tick. Small partial coverage — only registrations
-- that have ever had a penalty applied carry rows.
CREATE INDEX IF NOT EXISTS idx_race_penalties_registration
  ON public.race_penalties (race_registration_id);

-- Forensic queries ("who's been adjusting times this race?")
-- by operator + time. Cheap.
CREATE INDEX IF NOT EXISTS idx_race_penalties_applied
  ON public.race_penalties (applied_by, applied_at DESC)
  WHERE applied_by IS NOT NULL;

ALTER TABLE public.race_penalties ENABLE ROW LEVEL SECURITY;

-- Read + write for staff at the race's location, or master. The
-- join chain race_penalties → race_registrations → race_events →
-- locations mirrors what race_registrations does for itself.
DROP POLICY IF EXISTS race_penalties_location_scoped ON public.race_penalties;
CREATE POLICY race_penalties_location_scoped ON public.race_penalties
  FOR ALL
  TO authenticated
  USING (
    private.auth_is_master() OR EXISTS (
      SELECT 1
        FROM public.race_registrations rr
        JOIN public.race_events re ON re.id = rr.race_event_id
       WHERE rr.id = race_penalties.race_registration_id
         AND private.auth_is_in_location(re.location_id)
    )
  )
  WITH CHECK (
    private.auth_is_master() OR EXISTS (
      SELECT 1
        FROM public.race_registrations rr
        JOIN public.race_events re ON re.id = rr.race_event_id
       WHERE rr.id = race_penalties.race_registration_id
         AND private.auth_is_in_location(re.location_id)
    )
  );

COMMIT;
