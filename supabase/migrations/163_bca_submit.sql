-- ============================================================
-- 163: BCA.1 Phase 1 — CCFA BCA submit feature
-- ============================================================
--
-- WHY THIS MIGRATION EXISTS
-- ─────────────────────────
-- CCF Autos imports UK cars for Irish resale and must submit a
-- 10-document pack to BCA after each sale to claim back the UK VAT
-- ("the VAT bag"). Today the pack is assembled ad-hoc in Gmail +
-- Drive; cars get marked `completed` in the CRM before BCA is
-- actually filed, which costs real money in deferred refunds.
--
-- This migration introduces:
--   1. `locations.bca_config` JSONB column for per-location BCA
--      configuration (labels of the 10 doc slots, send-from + send-to
--      email addresses, subject/body templates). Editable in
--      `/settings/locations/[id]/bca` by master.
--   2. `car_bca_submissions` table — one row per submission attempt.
--      Resubmission allowed: each new row supersedes the previous via
--      `superseded_by` / `superseded_at`. The Phase 3 completion gate
--      will look for "active = not superseded + no Postmark error".
--   3. `bca-documents` Storage bucket, private, for both staged
--      uploads (per-car prefix) and submission-final files (per-
--      submission prefix). Path convention documented below.
--   4. `features.bca_submit = true` flipped on for CCF Autos location,
--      with a seeded default `bca_config` (10 placeholder slots,
--      empty send-from/-to ready for the operator to fill in).
--
-- Phase 1 is schema + UI for staging uploads + settings page. The
-- submit endpoint, the PDF merge step (pdf-lib + sharp), and the
-- completion gate land in Phase 2 + 3 — same schema, no further
-- table changes expected.

BEGIN;

-- ============================================================
-- (1) Per-location BCA config
-- ============================================================
-- JSONB on locations rather than a dedicated table because the
-- config is intrinsically 1:1 with location, fits in <2 KB, and
-- matches the pattern used elsewhere (locations.features). The
-- `features.bca_submit = true|false` boolean is the on/off switch;
-- this column holds the editable details.

ALTER TABLE public.locations
  ADD COLUMN IF NOT EXISTS bca_config JSONB;

COMMENT ON COLUMN public.locations.bca_config IS
  'BCA submit configuration: send_from, send_to, subject_template, body_template, documents[10]. NULL = no config yet; helper getBcaConfig() merges with defaults.';


-- ============================================================
-- (2) car_bca_submissions
-- ============================================================

CREATE TABLE IF NOT EXISTS public.car_bca_submissions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  car_id               UUID NOT NULL REFERENCES public.cars(id) ON DELETE CASCADE,
  location_id          UUID NOT NULL REFERENCES public.locations(id) ON DELETE RESTRICT,

  -- snapshot of the email actually sent (audit; don't read from live
  -- config — operator may have changed the config between submit and
  -- whenever we look back at this row).
  email_from           TEXT NOT NULL,
  email_to             TEXT NOT NULL,
  email_subject        TEXT NOT NULL,
  email_body           TEXT NOT NULL,

  -- snapshot of the 10 source documents (slug + label + storage_path +
  -- filename + size + content_type at time of send). Lets us rebuild
  -- the submission view long after the operator has renamed slot
  -- labels in settings.
  documents            JSONB NOT NULL,

  -- merged + compressed PDF that was actually attached to the email.
  -- Populated in Phase 2; Phase 1 never writes a row.
  merged_pdf_path      TEXT,
  merged_pdf_size      INTEGER,

  submitted_by         UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  submitted_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Postmark outcome. message_id present on success; error_code +
  -- error_msg populated on failure (we still keep the row — the
  -- attempt is part of the audit trail).
  postmark_message_id  TEXT,
  postmark_error_code  INTEGER,
  postmark_error_msg   TEXT,

  -- Resubmission chain. NULL = currently active. Each new submission
  -- stamps these on the previous row in the same transaction.
  superseded_by        UUID REFERENCES public.car_bca_submissions(id) ON DELETE SET NULL,
  superseded_at        TIMESTAMPTZ
);

-- Fast lookup of "the active submission for this car" — used by the
-- completion gate and the Submission History UI.
CREATE INDEX IF NOT EXISTS idx_car_bca_submissions_car_active
  ON public.car_bca_submissions (car_id)
  WHERE superseded_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_car_bca_submissions_location
  ON public.car_bca_submissions (location_id);

CREATE INDEX IF NOT EXISTS idx_car_bca_submissions_submitted_by
  ON public.car_bca_submissions (submitted_by);

ALTER TABLE public.car_bca_submissions ENABLE ROW LEVEL SECURITY;

-- Reads: any authenticated user at the location can see submissions
-- for cars at their location. service_role bypasses RLS (used by the
-- submit route + cron + sentinel).
CREATE POLICY "car_bca_submissions_read_at_location"
  ON public.car_bca_submissions
  FOR SELECT TO authenticated
  USING (
    location_id IN (
      SELECT pl.location_id
      FROM public.profile_locations pl
      WHERE pl.profile_id = (SELECT auth.uid())
    )
  );

-- Writes only via the API route (service-role).
CREATE POLICY "car_bca_submissions_no_anon"
  ON public.car_bca_submissions
  FOR ALL TO anon
  USING (false) WITH CHECK (false);

CREATE POLICY "car_bca_submissions_no_authenticated_write"
  ON public.car_bca_submissions
  FOR INSERT TO authenticated WITH CHECK (false);

CREATE POLICY "car_bca_submissions_no_authenticated_update"
  ON public.car_bca_submissions
  FOR UPDATE TO authenticated USING (false) WITH CHECK (false);

CREATE POLICY "car_bca_submissions_no_authenticated_delete"
  ON public.car_bca_submissions
  FOR DELETE TO authenticated USING (false);


-- ============================================================
-- (3) Storage bucket — bca-documents
-- ============================================================
-- Private bucket. Paths:
--   {location_id}/{car_id}/_staging/{slug}.{ext}
--     -- operator-staged uploads, not yet submitted. Each new upload
--        to the same slot overwrites the previous (operator iterating
--        on which file to send).
--   {location_id}/{car_id}/{submission_id}/{slug}.{ext}
--     -- frozen copies of the 10 sources at submission time. Never
--        overwritten; each resubmit gets its own submission_id prefix.
--   {location_id}/{car_id}/{submission_id}/merged.pdf
--     -- the merged + compressed PDF that was actually emailed.
--        Phase 2 produces this.
--
-- All API access goes through the service-role client (the routes
-- re-check location ownership manually). No direct PostgREST /
-- public-bucket access.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'bca-documents',
  'bca-documents',
  false,
  26214400,  -- 25 MB per upload; matches car-documents bucket
  ARRAY['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;

-- Block all anon + authenticated direct access; service-role bypasses.
-- (storage.objects RLS is enabled by Supabase by default; we just add
-- the explicit deny policies for clarity.)
CREATE POLICY "bca_documents_no_anon"
  ON storage.objects
  FOR ALL TO anon
  USING (bucket_id = 'bca-documents' AND false)
  WITH CHECK (bucket_id = 'bca-documents' AND false);

CREATE POLICY "bca_documents_no_authenticated"
  ON storage.objects
  FOR ALL TO authenticated
  USING (bucket_id = 'bca-documents' AND false)
  WITH CHECK (bucket_id = 'bca-documents' AND false);


-- ============================================================
-- (4) Seed CCF Autos
-- ============================================================
-- Flip the feature flag on for the CCF Autos location AND seed a
-- default bca_config. Operator can edit labels + email config in
-- /settings/locations/[id]/bca afterwards.

UPDATE public.locations
SET
  features = COALESCE(features, '{}'::jsonb) || '{"bca_submit": true}'::jsonb,
  bca_config = jsonb_build_object(
    'send_from', '',
    'send_to', '',
    'subject_template', 'BCA VAT claim — {{uk_reg}} ({{vin}})',
    'body_template',
      'Please find attached the 10-document pack for the UK VAT claim on {{uk_reg}}, {{make}} {{model}} {{vehicle_year}}.'
      || E'\n\n'
      || 'Buyer: {{buyer_name}}'
      || E'\n'
      || 'Xero invoice: {{xero_invoice_number}}'
      || E'\n\n'
      || 'Thanks,' || E'\n' || 'CCF Autos',
    'documents', jsonb_build_array(
      jsonb_build_object('slug', 'doc_01', 'label', 'Document 1 (placeholder)'),
      jsonb_build_object('slug', 'doc_02', 'label', 'Document 2 (placeholder)'),
      jsonb_build_object('slug', 'doc_03', 'label', 'Document 3 (placeholder)'),
      jsonb_build_object('slug', 'doc_04', 'label', 'Document 4 (placeholder)'),
      jsonb_build_object('slug', 'doc_05', 'label', 'Document 5 (placeholder)'),
      jsonb_build_object('slug', 'doc_06', 'label', 'Document 6 (placeholder)'),
      jsonb_build_object('slug', 'doc_07', 'label', 'Document 7 (placeholder)'),
      jsonb_build_object('slug', 'doc_08', 'label', 'Document 8 (placeholder)'),
      jsonb_build_object('slug', 'doc_09', 'label', 'Document 9 (placeholder)'),
      jsonb_build_object('slug', 'doc_10', 'label', 'Document 10 (placeholder)')
    )
  )
WHERE slug = 'ccf-autos';

COMMIT;
