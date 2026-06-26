-- ============================================================
-- 318: Consultation member feedback (champ-app Coaching hub, P2-2)
--
-- Adds a coach-authored feedback field that is EXPLICITLY shared with the
-- member in the champ-app — distinct from `notes`, which stays staff-only.
--
-- Privacy model (operator decision): members never see `notes`. There is
-- intentionally NO member RLS policy on `consultations`; the member reads
-- only this column via the customer-authed service-role route
-- GET /api/consultations/me (safe columns only). So a careless clinical note
-- in `notes` can never leak to the member app.
-- ============================================================

ALTER TABLE consultations ADD COLUMN IF NOT EXISTS member_feedback text;

COMMENT ON COLUMN consultations.member_feedback IS
  'Coach-authored feedback explicitly shared with the member in the champ-app (mig 318). Distinct from notes (staff-only). Surfaced read-only via the customer-authed GET /api/consultations/me (service-role, safe columns); no member RLS on consultations, so notes is never exposed.';
