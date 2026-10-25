-- 619 — SHIFTREMIND.1: let the push-reminder ledger record shift reminders.
--
-- WHY
-- ───
-- /api/cron/send-push-reminders reminds staff about tasks and bookings, and
-- dedups through push_reminder_sends (mig 169). Nothing reminds a coach about
-- a SHIFT on any channel. SHIFTREMIND.1 adds a `shift` arm to that cron: one
-- reminder per RUN of a coach's published shifts (shifts no more than 2 hours
-- apart), 2 hours before the run's first start, or 20:00 Dublin the evening
-- before when that would be before 07:00; never sent outside 07:00-22:00.
-- It reuses this ledger:
--
--   entity_type       = 'shift'
--   entity_id         = shift_assignments.id of the run's FIRST shift
--   recipient_id      = the coach (shift_assignments.profile_id)
--   lead_time_minutes = real minutes between the reminder's fire time and the
--                       shift start: 120, or 240..839 for an evening-before one
--
-- Mig 169 pinned entity_type to ('task', 'booking'). This widens it. Widening
-- only: no existing row can violate the new CHECK.
--
-- lead_time_minutes needs NO change: mig 170 already relaxed it to
-- BETWEEN 5 AND 10080.
--
-- DEPLOY ORDER: apply this BEFORE the SHIFTREMIND.1 code deploys. It is safe
-- alone (nothing writes 'shift' until the code exists). If the code lands
-- first, its ledger claim fails with 23514 and it sends nothing until this is
-- applied; it never spams.
--
-- REPLAYING THIS MIGRATION IS A NO-OP (drop-if-exists, then add).

ALTER TABLE public.push_reminder_sends
  DROP CONSTRAINT IF EXISTS push_reminder_sends_entity_type_check;

ALTER TABLE public.push_reminder_sends
  ADD CONSTRAINT push_reminder_sends_entity_type_check
  CHECK (entity_type IN ('task', 'booking', 'shift'));

-- Self-check (the mig 153b habit: verify the catalog, not the migration text).
-- The DROP above names the constraint by Postgres's auto-name for an inline
-- column CHECK. If prod's copy was ever named differently, the DROP was a
-- silent no-op and the OLD ('task','booking') CHECK is still there beside the
-- new one, still refusing 'shift'. Exactly one CHECK may mention entity_type.
-- A RAISE here aborts the migration's transaction, so nothing half-applies.
DO $$
DECLARE
  n int;
BEGIN
  SELECT count(*) INTO n
    FROM pg_constraint
   WHERE conrelid = 'public.push_reminder_sends'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%entity_type%';
  IF n <> 1 THEN
    RAISE EXCEPTION 'mig 619: expected exactly 1 CHECK on push_reminder_sends.entity_type, found %', n;
  END IF;
END $$;

COMMENT ON TABLE public.push_reminder_sends IS
  'NOTIF.1 + SHIFTREMIND.1 — dedup ledger for cron push reminders: tasks, bookings and (mig 619) shifts. One row per (entity_type, entity_id, recipient_id, lead_time_minutes). For entity_type = shift, entity_id is the shift_assignments.id of the first shift of a run and the row is a CLAIM inserted BEFORE the send, released (deleted) if the send fails outright. recipient_id is the profile that received the reminder.';
