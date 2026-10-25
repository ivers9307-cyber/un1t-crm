-- 666_event_type_whatsapp_confirmation.sql — EVENTCONFIRM-WA.1
--
-- Booking confirmations can go out on WhatsApp. SMS left with Twilio
-- (TWILIO-RETIRE.1, mig 664), which stranded the one live event type that
-- confirmed by SMS only ("Free UN1T Consultation", Stillorgan): from that
-- deploy it confirmed nothing. Richard's call (2026-09-30): send it by
-- WhatsApp instead, as an operator-set choice on the event type, not code.
--
-- Mig 074's "no WhatsApp for transactional booking messages" predates the
-- /start funnel, which has sent the UTILITY template booking_consult_confirmed
-- after a consult booking since the paid-ads program. This reverses 074 for
-- CONFIRMATIONS only; event_type_reminders.channels keeps its {email, sms}
-- CHECK (reminders stay email-only in code).
--
-- 1. confirmation_channels admits 'whatsapp'. 'sms' stays admitted so the
--    rows written before TWILIO-RETIRE.1 remain valid (the code skips it).
-- 2. confirmation_whatsapp_template_id — the approved template to send.
--    ON DELETE SET NULL: deleting a template must never block, and a
--    whatsapp channel with no template is a recorded skip, not an error.
--
-- No grant change: event_types carries table-level SELECT for
-- authenticated (mig 650) and no client write, so the new column is
-- readable exactly like its siblings and writable only by the
-- service-role event-type routes.

alter table public.event_types
  drop constraint if exists event_types_confirmation_channels_check;
alter table public.event_types
  add constraint event_types_confirmation_channels_check
  check (
    confirmation_channels is null
    or (
      confirmation_channels <@ array['email','sms','whatsapp']::text[]
      and array_length(confirmation_channels, 1) >= 1
    )
  );

alter table public.event_types
  add column if not exists confirmation_whatsapp_template_id uuid
    references public.whatsapp_templates(id) on delete set null;

comment on column public.event_types.confirmation_channels is
  'Channels for the booking confirmation: email and/or whatsapp. ''sms'' is still admitted for rows written before TWILIO-RETIRE.1 but is never sent. mig 077, widened mig 666.';
comment on column public.event_types.confirmation_whatsapp_template_id is
  'Approved WhatsApp template sent when confirmation_channels includes whatsapp. Body variables fill as {{1}} first name, {{2}} day + time, {{3}} event name. mig 666.';
