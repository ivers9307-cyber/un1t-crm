-- 292: HR-DETECT.1 — durable "detected HR" log. Every strap the bridge sees
-- (linked to a member or not) is recorded here, so the coach "Detected" tab can
-- list all HR activity + let staff link an unknown strap to a member.
--   hr_detections        = rolling registry, one row per (location_id, device_key)
--   hr_detection_visits  = appearance history, one row per contiguous visit
-- Recording is best-effort off /api/bridge/samples (anchor) + /api/bridge/scan (enrich).
-- RLS mirrors class_bookings (mig 288): staff-at-location read, service-role write.

CREATE TABLE IF NOT EXISTS public.hr_detections (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id       uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  device_key        text NOT NULL,
  protocol          text,
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  visit_count       integer NOT NULL DEFAULT 0,
  last_bpm          smallint,
  last_name         text,
  last_rssi         smallint,
  last_bridge_id    uuid REFERENCES public.ble_bridges(id) ON DELETE SET NULL,
  current_visit_id  uuid,   -- denormalised pointer (no FK) to the open visit
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_id, device_key)
);

CREATE INDEX IF NOT EXISTS idx_hr_detections_location_last_seen
  ON public.hr_detections (location_id, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS public.hr_detection_visits (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  detection_id      uuid NOT NULL REFERENCES public.hr_detections(id) ON DELETE CASCADE,
  location_id       uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  device_key        text NOT NULL,
  started_at        timestamptz NOT NULL DEFAULT now(),
  last_sample_at    timestamptz NOT NULL DEFAULT now(),
  peak_bpm          smallint,
  last_bpm          smallint,
  sample_count      integer NOT NULL DEFAULT 0,
  glofox_event_id   text,
  class_name        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hr_detection_visits_detection
  ON public.hr_detection_visits (detection_id, started_at DESC);

ALTER TABLE public.hr_detections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_detection_visits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "hr_detections_location_read" ON public.hr_detections
  FOR SELECT TO authenticated
  USING (private.auth_is_in_location(location_id));

CREATE POLICY "hr_detection_visits_location_read" ON public.hr_detection_visits
  FOR SELECT TO authenticated
  USING (private.auth_is_in_location(location_id));

COMMENT ON TABLE public.hr_detections IS
  'HR-DETECT.1 (mig 292): rolling registry of every HR strap the bridge detects at a location, linked or not. Best-effort upsert from /api/bridge/samples + /scan.';
COMMENT ON TABLE public.hr_detection_visits IS
  'HR-DETECT.1 (mig 292): per-visit appearance history for a detected strap. A visit = contiguous detections with gaps < 5min; closed implicitly when last_sample_at goes stale.';
COMMENT ON COLUMN public.hr_detections.current_visit_id IS
  'Denormalised pointer (no FK) to the open hr_detection_visits row, so the recording hot path decides extend-vs-new without a per-strap visit lookup.';
