-- 552 — EVENTS-SMS-TOGGLE: per-event opt-in for the race-registration SMS
-- confirmation.
--
-- race-confirmations.js (mig 084) sends the registration receipt over BOTH
-- Postmark email AND Twilio SMS, unconditionally — operators had no way to
-- turn the text off for a given event. This adds an explicit opt-in flag,
-- gated in the SMS branch (shouldSendSmsConfirmation) and surfaced as a
-- checkbox on the Edit event page (RaceEventForm).
--
-- DEFAULT false is a deliberate behaviour change: SMS was previously always
-- on, and the product decision is to make it opt-in. Every existing event
-- gets false on this ADD COLUMN, so the texts stop on deploy; operators
-- re-enable per event. The EMAIL receipt is a separate path and is NOT
-- gated by this flag (registrants still get their emailed check-in QR codes).

ALTER TABLE public.race_events
  ADD COLUMN IF NOT EXISTS confirmation_sms_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.race_events.confirmation_sms_enabled IS
  'EVENTS-SMS-TOGGLE (mig 552) — when true, the race-registration confirmation is ALSO sent by SMS (race-confirmations.js). Default false = SMS off. The email receipt is separate and always sent.';
