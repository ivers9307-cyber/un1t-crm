-- PAYLINK.1 — un1t_write_events admits origin 'staff_payment_link'.
--
-- The /buy/<token> POST finds or creates the customer's un1t.online account
-- (create_client) and asks for un1t.online's hosted checkout (checkout) with
-- origin 'staff_payment_link', origin_ref = staff_payment_links.id. The origin
-- CHECK (last set by mig 827) did not list it, so the write ledger's insert
-- would fail 23514 and no payment link could ever reach a checkout.
--
-- Every origin mig 827 admitted is kept. Apply BEFORE the PAYLINK.1 code deploys.

ALTER TABLE public.un1t_write_events
  DROP CONSTRAINT IF EXISTS un1t_write_events_origin_check;
ALTER TABLE public.un1t_write_events
  ADD CONSTRAINT un1t_write_events_origin_check
  CHECK (origin IN ('staff', 'funnel', 'approval', 'mia', 'test_account', 'web_trial', 'fee_run', 'corp_promo', 'web_offer', 'staff_payment_link'));
