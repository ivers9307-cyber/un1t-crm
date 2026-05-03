-- 077 — Booking confirmation flow.
--
-- When a customer books, they expect immediate confirmation in
-- their inbox / on their phone — separate from the reminder N
-- minutes before the slot. This adds the per-event_type config
-- for that one-shot confirmation message.
--
-- Same channel set as reminders (mig 076): email and/or SMS,
-- WhatsApp deliberately excluded (mig 074 policy — WA is for
-- explicit campaigns, not transactional).
--
-- Stored as columns on event_types rather than a new table
-- because confirmations are naturally singular: one per booking,
-- not a sequence. The reminder model needed multi-row to support
-- "24h + 2h + day-of"; confirmations don't.

alter table public.event_types
  add column if not exists confirmation_enabled boolean not null default false,
  add column if not exists confirmation_channels text[],
  add column if not exists confirmation_email_template_id uuid references public.email_templates(id),
  add column if not exists confirmation_email_subject text,
  add column if not exists confirmation_sms_body text;

alter table public.event_types
  drop constraint if exists event_types_confirmation_channels_check;
alter table public.event_types
  add constraint event_types_confirmation_channels_check
  check (
    confirmation_channels is null
    or (
      confirmation_channels <@ array['email','sms']::text[]
      and array_length(confirmation_channels, 1) >= 1
    )
  );

comment on column public.event_types.confirmation_enabled is
  'Send a one-shot confirmation message at booking time. mig 077.';
comment on column public.event_types.confirmation_channels is
  'Channels for the booking confirmation. Email or SMS only. mig 077.';
comment on column public.event_types.confirmation_email_template_id is
  'Email template used when confirmation_channels includes email. Falls back to a default subject if not set. mig 077.';
comment on column public.event_types.confirmation_email_subject is
  'Optional subject override for the confirmation email. Merge tags supported. mig 077.';
comment on column public.event_types.confirmation_sms_body is
  'SMS body for the confirmation message. Merge tags supported (first_name, event_name, event_time, location_name). mig 077.';
