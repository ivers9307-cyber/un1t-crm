-- 293: SESSION-REPORT.2 — operator-editable cardio/strength/conditioning category
-- per class type, keyed by the (normalized) class NAME so it covers bridge-tracked
-- Glofox sessions (heart_rate_sessions.class_name) as well as CRM bookings. Drives
-- the post-class report's session.class.category + comparisons.vs_category.

CREATE TABLE IF NOT EXISTS public.class_categories (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id            uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  class_name             text NOT NULL,
  class_name_normalized  text NOT NULL,
  category               text NOT NULL CHECK (category IN ('cardio','strength','conditioning')),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_id, class_name_normalized)
);

CREATE INDEX IF NOT EXISTS idx_class_categories_location
  ON public.class_categories (location_id);

ALTER TABLE public.class_categories ENABLE ROW LEVEL SECURITY;

-- Non-sensitive class labels: readable by ANY authenticated user (the customer
-- app's report loader needs them, and customers aren't staff-at-location). Writes
-- are service-role only (via the manager-gated settings API).
CREATE POLICY "class_categories_read_all_authenticated" ON public.class_categories
  FOR SELECT TO authenticated
  USING (true);

COMMENT ON TABLE public.class_categories IS
  'SESSION-REPORT.2 (mig 293): per-location class-name → cardio/strength/conditioning map. Keyed by class_name_normalized = lower(btrim(class_name)). SELECT open to authenticated (non-sensitive labels read by both the CRM and the customer app); writes service-role only.';
