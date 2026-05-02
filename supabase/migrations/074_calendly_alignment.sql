-- 074 — Calendly feature alignment with current platform conventions.
--
-- Two things in one migration because they touch the same triggers
-- and shouldn't be deployed independently:
--
-- 1. Booking → activity classification bug (mig 073 fallout).
--    The booking-creation trigger inserts an activity with
--    due_date = NEW.booking_date. After the activities revamp
--    (mig 073), the kind-inference rule "due_date IS NOT NULL →
--    task" misclassifies these as tasks. They show up in the
--    /tasks list with a checkbox, which is semantically wrong —
--    a booking is something that HAPPENED, not something to do.
--    Fix: trigger now writes kind='event' explicitly and leaves
--    due_date/due_time NULL. One-shot UPDATE on existing rows.
--
-- 2. Reminder channel restriction (no WhatsApp).
--    Booking reminders are SMS or email only. WhatsApp templates
--    require Meta approval and the operator wants to keep that
--    channel for explicit campaigns, not transactional reminders.
--    CHECK constraint enforces the policy at the DB level so a
--    direct UPDATE can't smuggle 'whatsapp' back in. Live data
--    is clean (only one event_type, reminders disabled), so no
--    backfill drama.

-- ============================================================
-- 1. Update handle_new_booking trigger to write kind='event'.
-- The trigger lives in mig 003. Replicating it here with the
-- updated INSERT shape; the function definition is otherwise
-- unchanged.
-- ============================================================
CREATE OR REPLACE FUNCTION handle_new_booking()
RETURNS TRIGGER AS $$
DECLARE
  v_contact_id UUID;
  v_deal_id UUID;
  v_event_name TEXT;
  v_event_location_id UUID;
BEGIN
  -- Find or create contact by email
  SELECT id INTO v_contact_id
  FROM contacts
  WHERE email = NEW.customer_email
  LIMIT 1;

  IF v_contact_id IS NULL THEN
    INSERT INTO contacts (name, email, phone, source)
    VALUES (NEW.customer_name, NEW.customer_email, NEW.customer_phone, 'booking')
    RETURNING id INTO v_contact_id;
  END IF;

  NEW.contact_id := v_contact_id;

  -- Look up event name + its location for the activity row.
  SELECT name, location_id
    INTO v_event_name, v_event_location_id
    FROM event_types
   WHERE id = NEW.event_type_id;

  -- Find or create the deal at "New Lead" stage.
  SELECT id INTO v_deal_id
    FROM deals
   WHERE contact_id = v_contact_id
     AND status = 'open'
   LIMIT 1;

  IF v_deal_id IS NULL THEN
    INSERT INTO deals (contact_id, title, status, stage)
    VALUES (
      v_contact_id,
      'Booked: ' || COALESCE(v_event_name, 'Event'),
      'open',
      'new_lead'
    )
    RETURNING id INTO v_deal_id;
  END IF;

  -- Log to the contact timeline as a kind='event' activity (mig 073
  -- semantics). due_date/due_time intentionally NULL — events live
  -- on the timeline by created_at, not in the task queue.
  INSERT INTO activities (
    subject, type, kind, contact_id, deal_id, due_date, due_time, note, done, location_id
  ) VALUES (
    'Booking confirmed: ' || COALESCE(v_event_name, 'Event'),
    'booking',
    'event',
    v_contact_id,
    v_deal_id,
    NULL,
    NULL,
    'Booked ' || COALESCE(v_event_name, 'Event') || ' on ' ||
      TO_CHAR(NEW.booking_date, 'DD Mon YYYY') || ' at ' ||
      TO_CHAR(NEW.start_time, 'HH24:MI'),
    true,            -- events are "done" by definition (already happened)
    COALESCE(v_event_location_id, NEW.location_id)
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================
-- 2. Update handle_booking_status_change trigger similarly.
-- Booking goes confirmed → cancelled or confirmed → no_show:
-- log a kind='event' row, NULL due_date/due_time.
-- ============================================================
CREATE OR REPLACE FUNCTION handle_booking_status_change()
RETURNS TRIGGER AS $$
DECLARE
  v_event_name TEXT;
  v_event_location_id UUID;
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  SELECT name, location_id
    INTO v_event_name, v_event_location_id
    FROM event_types
   WHERE id = NEW.event_type_id;

  INSERT INTO activities (
    subject, type, kind, contact_id, due_date, due_time, note, done, location_id
  ) VALUES (
    'Booking ' || NEW.status || ': ' || COALESCE(v_event_name, 'Event'),
    'booking',
    'event',
    NEW.contact_id,
    NULL,
    NULL,
    COALESCE(v_event_name, 'Event') || ' on ' ||
      TO_CHAR(NEW.booking_date, 'DD Mon YYYY') || ' — status changed from ' ||
      OLD.status || ' to ' || NEW.status,
    true,
    COALESCE(v_event_location_id, NEW.location_id)
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================
-- 3. Backfill: existing booking activities classified as tasks
-- by the mig 073 inference rule should be events. Two existing
-- rows in prod, both with due_date/due_time set.
-- ============================================================
UPDATE public.activities
   SET kind = 'event',
       due_date = NULL,
       due_time = NULL,
       done = true
 WHERE type = 'booking'
   AND kind = 'task';

-- ============================================================
-- 4. Reminder channel CHECK — SMS or email only.
-- Drops 'whatsapp' as a valid value going forward. Live data
-- has zero rows with reminder_channel='whatsapp', so this
-- applies cleanly.
-- ============================================================
ALTER TABLE public.event_types
  DROP CONSTRAINT IF EXISTS event_types_reminder_channel_check;

ALTER TABLE public.event_types
  ADD CONSTRAINT event_types_reminder_channel_check
  CHECK (reminder_channel IS NULL OR reminder_channel IN ('email', 'sms'));

COMMENT ON COLUMN public.event_types.reminder_channel IS
  'Per-event-type booking reminder channel. Email or SMS only — WhatsApp templates are reserved for explicit campaigns, not transactional reminders (mig 074).';
