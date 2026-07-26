-- 448: HYROX-MOBILE (Batch D) — 30-min-before coach reminder for Hyrox classes.
-- A cron (every 5 min) finds each imminent HYROX class and pushes the on-shift
-- coach(es) to review the workout. Three pieces:
--   1. hyrox_class_reminders — dedupe log (one row per class occurrence) so the
--      5-min cron sends exactly once, not every tick for 30 minutes.
--   2. cron_heartbeats row (name MUST match stampHeartbeat('hyrox-class-reminder')).
--   3. hyrox_coaches_on_shift() — TZ-safe roster overlap: which coaches' shift
--      covers a class window. Times on shift_blocks are Dublin wall-clock (estate
--      convention), so the class instant is converted with AT TIME ZONE 'Europe/Dublin'.

CREATE TABLE IF NOT EXISTS public.hyrox_class_reminders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id     uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  class_starts_at timestamptz NOT NULL,
  session_id      uuid REFERENCES public.hyrox_sessions(id) ON DELETE SET NULL,
  recipient_count smallint,
  sent_at         timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (location_id, class_starts_at)
);

-- Internal cron-written dedupe table. RLS on with NO policy = no authenticated
-- access; the reminder cron reads/writes it with the service role (RLS-bypassing).
ALTER TABLE public.hyrox_class_reminders ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.hyrox_class_reminders IS
  'Dedupe log for the 30-min-before Hyrox coach-reminder cron. Cron-written (service role); RLS enabled with no policy (no authenticated access).';

INSERT INTO public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, last_ok_at)
VALUES ('hyrox-class-reminder', 300, 600, NOW())
ON CONFLICT (name) DO NOTHING;

-- Coaches whose rostered shift overlaps a class window [p_start, p_end).
-- shift_blocks.start_time/end_time (and the per-assignment overrides) are Dublin
-- wall-clock times on block_date; the class instant is converted to Dublin
-- wall-clock so both sides compare in the same frame. Overlap = block starts
-- before the class ends AND ends after the class starts.
CREATE OR REPLACE FUNCTION public.hyrox_coaches_on_shift(
  p_location uuid, p_start timestamptz, p_end timestamptz
)
RETURNS TABLE(profile_id uuid)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT DISTINCT a.profile_id
  FROM public.shift_blocks b
  JOIN public.shift_assignments a
    ON a.block_id = b.id
   AND COALESCE(a.status, '') <> 'cancelled'
  WHERE b.location_id = p_location
    AND b.block_date = (p_start AT TIME ZONE 'Europe/Dublin')::date
    AND (b.block_date + COALESCE(a.start_time_override, b.start_time)) < (p_end   AT TIME ZONE 'Europe/Dublin')
    AND (b.block_date + COALESCE(a.end_time_override,   b.end_time))   > (p_start AT TIME ZONE 'Europe/Dublin');
$$;
