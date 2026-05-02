-- 062 — sequence_steps: SMS step type
--
-- Phase 3 of the SMS rollout. mig 005 created sequence_steps with
-- step_type = 'email' | 'wait' | 'condition' | 'sms' | 'whatsapp'
-- (the comment said "future: sms, whatsapp"; mig 039 wired up
-- whatsapp). This migration finishes the job for SMS.
--
-- The runner (src/lib/sequences.js#runSequences) branches by
-- step_type. Adding 'sms' there + this column is all that's needed
-- on the data side; the existing per-step delay / order / metrics
-- columns work unchanged.

alter table sequence_steps
  add column if not exists sms_body text;

comment on column sequence_steps.sms_body is
  'For step_type=sms — freeform message body sent via Twilio. Merge tags (same set as email + ad-hoc SMS) are applied at send time. Hard-capped at 1600 chars in the runner to mirror the broadcast cap.';

-- Cheap partial index for the rare case the runner ever needs to
-- list SMS steps directly (sequence detail page filtering, etc.).
create index if not exists sequence_steps_sms_idx
  on sequence_steps (sequence_id)
  where step_type = 'sms';
