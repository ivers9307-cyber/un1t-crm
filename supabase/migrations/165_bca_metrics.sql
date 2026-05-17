-- ============================================================
-- 165: BCA.1 Phase 5 — email + link tracking metrics
-- ============================================================
--
-- Adds visibility into what BCA actually does with the submission:
--
--   email side (filled by the existing process-postmark-webhooks
--   cron when it sees a webhook tagged 'bca-submit')
--     - delivered_at, delivered_to
--     - first_opened_at, last_opened_at, open_count
--     - first_clicked_at, last_clicked_at, click_count
--     - bounced_at, bounce_type, bounce_description
--     - complaint_at
--     - last_postmark_event_at  (catch-all heartbeat)
--
--   link side (filled by the new /api/public/bca/[token]/* routes)
--     - first_viewed_at, last_viewed_at, view_count
--     - first_merged_download_at, last_merged_download_at,
--       merged_download_count
--
-- Granular per-event audit log in a new car_bca_submission_events
-- table — every webhook + every public-page action gets a row with
-- ip + user_agent for forensic lookback. Roll-ups on the submission
-- row are cheaper to query for the BcaSubmitCard render.

BEGIN;

ALTER TABLE public.car_bca_submissions
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS delivered_to TEXT,
  ADD COLUMN IF NOT EXISTS first_opened_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_opened_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS open_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS first_clicked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_clicked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS click_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bounced_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS bounce_type TEXT,
  ADD COLUMN IF NOT EXISTS bounce_description TEXT,
  ADD COLUMN IF NOT EXISTS complaint_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_postmark_event_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS first_viewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_viewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS view_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS first_merged_download_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_merged_download_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS merged_download_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.car_bca_submission_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id    UUID NOT NULL REFERENCES public.car_bca_submissions(id) ON DELETE CASCADE,
  event_type       TEXT NOT NULL CHECK (event_type IN (
    'delivered', 'opened', 'clicked', 'bounced', 'complained',
    'page_view', 'download_merged', 'download_file'
  )),
  file_slug        TEXT,
  ip               TEXT,
  user_agent       TEXT,
  raw_payload      JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_car_bca_submission_events_submission
  ON public.car_bca_submission_events (submission_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_car_bca_submission_events_type
  ON public.car_bca_submission_events (event_type, created_at DESC);

ALTER TABLE public.car_bca_submission_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "car_bca_submission_events_read_at_location"
  ON public.car_bca_submission_events
  FOR SELECT TO authenticated
  USING (
    submission_id IN (
      SELECT s.id FROM public.car_bca_submissions s
      WHERE s.location_id IN (
        SELECT pl.location_id FROM public.profile_locations pl
        WHERE pl.profile_id = (SELECT auth.uid())
      )
    )
  );

CREATE POLICY "car_bca_submission_events_no_anon"
  ON public.car_bca_submission_events
  FOR ALL TO anon
  USING (false) WITH CHECK (false);

CREATE POLICY "car_bca_submission_events_no_authenticated_write"
  ON public.car_bca_submission_events
  FOR INSERT TO authenticated WITH CHECK (false);

COMMIT;
