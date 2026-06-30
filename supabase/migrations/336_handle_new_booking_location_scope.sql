-- IDOR parity for the public booking path. handle_new_booking matched an
-- existing contact by email GLOBALLY and case-sensitively (and didn't stamp
-- location_id on contacts it created), so a public booking could resolve — and
-- then write a deal/activity against — an existing contact known to be at a
-- different location, from a bare email. This scopes the match to the booking's
-- location (resolved first) + makes it case-insensitive, and stamps location_id
-- on new contacts. Legacy unscoped/NULL-location contacts still match so
-- returning bookers aren't duplicated. (Applied to prod via the Supabase MCP
-- migration 'handle_new_booking_location_scope'.)
CREATE OR REPLACE FUNCTION public.handle_new_booking()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_contact_id UUID;
  v_deal_id UUID;
  v_event_name TEXT;
  v_event_location_id UUID;
  v_location_id UUID;
  v_stage_id UUID;
  v_name_parts TEXT[];
  v_first_name TEXT;
  v_last_name TEXT;
BEGIN
  -- Resolve the booking's location FIRST so the contact match can be scoped to it.
  SELECT name, location_id
    INTO v_event_name, v_event_location_id
    FROM event_types
   WHERE id = NEW.event_type_id;

  v_location_id := COALESCE(v_event_location_id, NEW.location_id);

  -- Case-insensitive, location-scoped match (or a legacy unscoped contact);
  -- never a contact known to live at a different location.
  SELECT id INTO v_contact_id
  FROM contacts
  WHERE lower(email) = lower(NEW.customer_email)
    AND (location_id = v_location_id OR location_id IS NULL)
  LIMIT 1;

  IF v_contact_id IS NULL THEN
    IF NULLIF(btrim(NEW.customer_name), '') IS NOT NULL THEN
      v_name_parts := regexp_split_to_array(btrim(NEW.customer_name), '\s+');
      v_first_name := v_name_parts[1];
      v_last_name  := NULLIF(array_to_string(v_name_parts[2:], ' '), '');
    END IF;

    INSERT INTO contacts (name, first_name, last_name, email, phone, source, location_id)
    VALUES (NEW.customer_name, v_first_name, v_last_name, NEW.customer_email, NEW.customer_phone, 'booking', v_location_id)
    RETURNING id INTO v_contact_id;
  END IF;

  NEW.contact_id := v_contact_id;

  SELECT id INTO v_deal_id
    FROM deals
   WHERE contact_id = v_contact_id
     AND status = 'open'
   LIMIT 1;

  IF v_deal_id IS NULL THEN
    SELECT id INTO v_stage_id
      FROM pipeline_stages
     WHERE location_id = v_location_id
       AND slug = 'new_lead'
       AND archived = false
     ORDER BY display_order
     LIMIT 1;

    INSERT INTO deals (contact_id, title, status, stage_id, location_id)
    VALUES (
      v_contact_id,
      'Booked: ' || COALESCE(v_event_name, 'Event'),
      'open',
      v_stage_id,
      v_location_id
    )
    RETURNING id INTO v_deal_id;
  END IF;

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
    true,
    v_location_id
  );

  RETURN NEW;
END;
$function$;
