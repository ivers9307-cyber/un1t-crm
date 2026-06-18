-- 290: CLASS-TIMER — reusable interval-timer templates + the single live run
-- per location. The server stores authoritative state; displays compute the
-- tick locally (see src/lib/class-timer.js).
CREATE TABLE IF NOT EXISTS public.class_timer_templates (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id    uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  name           text NOT NULL,
  structure      jsonb NOT NULL,
  total_seconds  int,
  glofox_program text,
  is_active      boolean NOT NULL DEFAULT true,
  created_by     uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_class_timer_templates_loc
  ON public.class_timer_templates (location_id) WHERE is_active;

CREATE TABLE IF NOT EXISTS public.class_timer_runs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id        uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  template_id        uuid REFERENCES public.class_timer_templates(id) ON DELETE SET NULL,
  structure_snapshot jsonb NOT NULL,
  name               text,
  status             text NOT NULL DEFAULT 'running'
                       CHECK (status IN ('running','paused','finished','stopped')),
  started_at         timestamptz,
  paused_at          timestamptz,
  paused_accum_ms    bigint NOT NULL DEFAULT 0,
  elapsed_offset_ms  bigint NOT NULL DEFAULT 0,
  started_by         uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
-- At most one live (running|paused) run per location.
CREATE UNIQUE INDEX IF NOT EXISTS idx_class_timer_runs_one_live
  ON public.class_timer_runs (location_id) WHERE status IN ('running','paused');
CREATE INDEX IF NOT EXISTS idx_class_timer_runs_loc_status
  ON public.class_timer_runs (location_id, status);

ALTER TABLE public.class_timer_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.class_timer_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "class_timer_templates_read" ON public.class_timer_templates
  FOR SELECT TO authenticated USING (private.auth_is_in_location(location_id));
CREATE POLICY "class_timer_runs_read" ON public.class_timer_runs
  FOR SELECT TO authenticated USING (private.auth_is_in_location(location_id));

COMMENT ON TABLE public.class_timer_templates IS 'CLASS-TIMER (mig 290): reusable interval-timer templates.';
COMMENT ON TABLE public.class_timer_runs IS 'CLASS-TIMER (mig 290): the live timer run per location; one running/paused row at a time.';
