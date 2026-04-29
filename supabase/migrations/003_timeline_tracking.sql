-- ============================================================
-- 003: Timeline Tracking
-- Auto-log booking events, status changes, and pipeline moves
-- to the contact's timeline (activities table)
-- ============================================================

-- 1. Update handle_new_booking to also create a timeline activity
CREATE OR REPLACE FUNCTION handle_new_booking()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql
AS $$
DECLARE
  v_contact_id UUID;
  v_event_name TEXT;
  v_webhook_url TEXT;
  v_stage_id UUID;
  v_deal_id UUID;
BEGIN
  -- Find or create contact
  SELECT id INTO v_contact_id
  FROM contacts
  WHERE email = NEW.customer_email
  LIMIT 1;

  IF v_contact_id IS NULL THEN
    INSERT INTO contacts (name, email, phone, source)
    VALUES (NEW.customer_name, NEW.customer_email, NEW.customer_phone, 'booking')
    RETURNING id INTO v_contact_id;
  END IF;

  -- Link booking to contact
  NEW.contact_id := v_contact_id;

  -- Get event name
  SELECT name INTO v_event_name
  FROM event_types
  WHERE id = NEW.event_type_id;

  -- Look up the "New Lead" pipeline stage
  SELECT id INTO v_stage_id
  FROM pipeline_stages
  WHERE slug = 'new_lead'
  LIMIT 1;

  -- Create deal
  INSERT INTO deals (contact_id, title, stage_id, status)
  VALUES (
    v_contact_id,
    COALESCE(v_event_name, 'Booking') || ' — ' || NEW.customer_name,
    v_stage_id,
    'open'
  )
  RETURNING id INTO v_deal_id;

  -- Log booking confirmation to timeline
  INSERT INTO activities (
    subject, type, contact_id, deal_id, due_date, due_time, note, done
  ) VALUES (
    'Booking confirmed: ' || COALESCE(v_event_name, 'Event'),
    'booking',
    v_contact_id,
    v_deal_id,
    NEW.booking_date,
    NEW.start_time,
    'Booked ' || COALESCE(v_event_name, 'Event') || ' on ' ||
      TO_CHAR(NEW.booking_date, 'DD Mon YYYY') || ' at ' ||
      TO_CHAR(NEW.start_time, 'HH12:MI AM') ||
      '. Source: ' || COALESCE(NEW.source, 'booking_page'),
    false
  );

  -- Fire webhook if configured
  SELECT webhook_url INTO v_webhook_url
  FROM event_types
  WHERE id = NEW.event_type_id;

  IF v_webhook_url IS NOT NULL AND v_webhook_url != '' THEN
    BEGIN
      PERFORM net.http_post(
        url := v_webhook_url,
        body := json_build_object(
          'event', 'booking.created',
          'booking_id', NEW.id,
          'contact_id', v_contact_id,
          'customer_name', NEW.customer_name,
          'customer_email', NEW.customer_email,
          'event_type', v_event_name,
          'booking_date', NEW.booking_date,
          'start_time', NEW.start_time
        )::jsonb
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE LOG 'Webhook failed for booking %: %', NEW.id, SQLERRM;
    END;
  END IF;

  RETURN NEW;
END;
$$;


-- 2. Track deal stage changes on the contact timeline
CREATE OR REPLACE FUNCTION log_deal_stage_change()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql
AS $$
DECLARE
  v_old_stage TEXT;
  v_new_stage TEXT;
BEGIN
  -- Only fire when stage_id actually changes
  IF OLD.stage_id IS DISTINCT FROM NEW.stage_id THEN
    SELECT name INTO v_old_stage FROM pipeline_stages WHERE id = OLD.stage_id;
    SELECT name INTO v_new_stage FROM pipeline_stages WHERE id = NEW.stage_id;

    INSERT INTO activities (subject, type, contact_id, deal_id, note, done)
    VALUES (
      'Pipeline: moved to ' || COALESCE(v_new_stage, 'Unknown'),
      'pipeline',
      NEW.contact_id,
      NEW.id,
      'Deal "' || NEW.title || '" moved from ' ||
        COALESCE(v_old_stage, 'Unknown') || ' to ' || COALESCE(v_new_stage, 'Unknown'),
      true
    );
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER deal_stage_change_trigger
  AFTER UPDATE ON deals
  FOR EACH ROW
  EXECUTE FUNCTION log_deal_stage_change();


-- 3. Track booking status changes on the contact timeline
CREATE OR REPLACE FUNCTION log_booking_status_change()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql
AS $$
DECLARE
  v_event_name TEXT;
BEGIN
  -- Only fire when status actually changes
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    SELECT name INTO v_event_name FROM event_types WHERE id = NEW.event_type_id;

    INSERT INTO activities (subject, type, contact_id, due_date, due_time, note, done)
    VALUES (
      'Booking ' || NEW.status || ': ' || COALESCE(v_event_name, 'Event'),
      'booking',
      NEW.contact_id,
      NEW.booking_date,
      NEW.start_time,
      COALESCE(v_event_name, 'Event') || ' on ' ||
        TO_CHAR(NEW.booking_date, 'DD Mon YYYY') || ' — status changed from ' ||
        OLD.status || ' to ' || NEW.status,
      true
    );
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER booking_status_change_trigger
  AFTER UPDATE ON bookings
  FOR EACH ROW
  EXECUTE FUNCTION log_booking_status_change();
