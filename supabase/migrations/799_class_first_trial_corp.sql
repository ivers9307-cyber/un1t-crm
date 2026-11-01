-- CLASSFIRST.1 — /trial and /corp ask for the class before the details
-- (docs/superpowers/specs/2026-11-01-class-first-trial-corp-design.md).
--
-- The chosen class travels with the purchase (trial_purchases) or the claim
-- (corp_promo_claims): the SERVER's event id, name and start, validated
-- against the studio's visible timetable by the public POST, never the
-- client's words. Once the credits land (the Glofox grant, the un1t.online
-- settle, the promo grant) a class_booking_requests row is queued for it,
-- marked funded_by that row, so the processors never grant a free trial for
-- it and file a card (funded_no_balance) when the balance reads empty.
--
-- All three tables are service-role only (RLS on, no client privilege):
-- a new column needs no grant decision.

ALTER TABLE public.trial_purchases
  ADD COLUMN IF NOT EXISTS class_event_id  text,
  ADD COLUMN IF NOT EXISTS class_name      text,
  ADD COLUMN IF NOT EXISTS class_starts_at timestamptz;

ALTER TABLE public.corp_promo_claims
  ADD COLUMN IF NOT EXISTS class_event_id  text,
  ADD COLUMN IF NOT EXISTS class_name      text,
  ADD COLUMN IF NOT EXISTS class_starts_at timestamptz;

ALTER TABLE public.class_booking_requests
  ADD COLUMN IF NOT EXISTS funded_by    text,
  ADD COLUMN IF NOT EXISTS funded_by_id uuid;

ALTER TABLE public.class_booking_requests
  DROP CONSTRAINT IF EXISTS class_booking_requests_funded_by_check;
ALTER TABLE public.class_booking_requests
  ADD CONSTRAINT class_booking_requests_funded_by_check
  CHECK (funded_by IS NULL OR funded_by IN ('trial_purchase', 'corp_promo'));

COMMENT ON COLUMN public.trial_purchases.class_event_id IS
  'CLASSFIRST.1: the class the buyer picked before paying (the studio''s event id, server-validated). Queued on class_booking_requests once the trial is granted.';
COMMENT ON COLUMN public.corp_promo_claims.class_event_id IS
  'CLASSFIRST.1: the class the claimant picked before their details (the un1t.online event id, server-validated). Queued on class_booking_requests once the credits are granted.';
COMMENT ON COLUMN public.class_booking_requests.funded_by IS
  'CLASSFIRST.1: trial_purchase | corp_promo when the booking rides credits a purchase or claim already put on the account (funded_by_id is that row). The processors never grant a trial for such a row; an empty balance is a funded_no_balance card.';
