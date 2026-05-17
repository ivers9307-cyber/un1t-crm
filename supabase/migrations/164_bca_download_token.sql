-- ============================================================
-- 164: BCA.1 Phase 4 — public download page for the email recipient
-- ============================================================
--
-- BCA's email recipient sometimes can't open the attached merged PDF
-- (corporate mail server stripped it, attachment corrupted, lost in
-- transit, etc.). Adds a per-submission public download token + a
-- 60-day expiry so they can re-download the merged PDF and / or
-- individual source files without needing the operator to forward
-- the email again.
--
-- Token-keyed page lives at /bca/<download_token>. Anon access:
-- service-role client reads the row + generates fresh short-lived
-- signed URLs for each file at render time (no need to maintain
-- long-lived signed URLs). After download_expires_at the page shows
-- an expired state and refuses to generate signed URLs.
--
-- Token: 24-byte URL-safe base64 (~190 bits entropy), minted in the
-- submit route and never reused. Token UNIQUE-indexed (partial, so
-- NULLs on pre-Phase-4 rows are allowed — there are 0 rows in prod
-- at ship time anyway).
--
-- Window: 60 days from submitted_at. BCA_DOWNLOAD_WINDOW_DAYS in
-- src/lib/bca.js is the single source of truth on the JS side.

BEGIN;

ALTER TABLE public.car_bca_submissions
  ADD COLUMN IF NOT EXISTS download_token TEXT,
  ADD COLUMN IF NOT EXISTS download_expires_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_car_bca_submissions_download_token_unique
  ON public.car_bca_submissions (download_token)
  WHERE download_token IS NOT NULL;

COMMENT ON COLUMN public.car_bca_submissions.download_token IS
  'URL-safe random slug (~190 bits entropy) keying /bca/<token>. Generated app-side at submit; null on rows created before BCA.1 Phase 4 (set has no rows in prod at ship time).';
COMMENT ON COLUMN public.car_bca_submissions.download_expires_at IS
  'When the public /bca/<token> page stops working. 60 days after submitted_at by convention; older rows null.';

COMMIT;
