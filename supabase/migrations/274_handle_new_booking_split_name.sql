-- 274_handle_new_booking_split_name.sql
-- Repair the handle_new_booking trigger (fires BEFORE INSERT on
-- bookings as booking_created_trigger). Two fixes:
--
-- 1. NAME SPLIT (the assigned task). The contact it auto-creates for a
--    new booking now gets first_name/last_name, not just the combined
--    `name`. Same defect class as the event/race signup path fixed in
--    mig 273 / PR #540: contacts created with `name` only leave
--    first_name/last_name NULL, which blanks the contact edit form and
--    disables "Create in Glofox". Split mirrors src/lib/name-utils.js
--    splitName(): first whitespace token -> first_name, the rest ->
--    last_name, NULL last_name for a single token, both NULL for blank.
--
-- 2. STAGE_ID REPAIR (discovered while verifying #1). The trigger still
--    inserted the deal with the old `deals.stage` TEXT column ('new_lead'),
--    but PIPELINE5 (mig 147) replaced it with `stage_id` -> pipeline_stages
--    (per-location). So the deal INSERT threw "column stage does not exist"
--    whenever it ran — i.e. for any booking that needed to create a deal
--    (a brand-new email / a contact with no open deal). Because the trigger
--    is BEFORE INSERT, that aborted the whole booking. Net effect: NEW
--    customers could not book via the public booking page (existing leads
--    with an open deal were unaffected, which is why it went unnoticed).
--    Fix: resolve the location's active `new_lead` stage at runtime and
--    insert stage_id + location_id. new_lead is still the active entry
--    stage, so this preserves the original intent exactly.
--
-- Body otherwise reproduced verbatim from the live definition
-- (pg_get_functiondef, 2026-06-15).

create or replace function public.handle_new_booking()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
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
  SELECT id INTO v_contact_id
  FROM contacts
  WHERE email = NEW.customer_email
  LIMIT 1;

  IF v_contact_id IS NULL THEN
    -- Split the single booking name into first/last (mirrors
    -- name-utils.splitName); leave both NULL when the name is blank.
    IF NULLIF(btrim(NEW.customer_name), '') IS NOT NULL THEN
      v_name_parts := regexp_split_to_array(btrim(NEW.customer_name), '\s+');
      v_first_name := v_name_parts[1];
      v_last_name  := NULLIF(array_to_string(v_name_parts[2:], ' '), '');
    END IF;

    INSERT INTO contacts (name, first_name, last_name, email, phone, source)
    VALUES (NEW.customer_name, v_first_name, v_last_name, NEW.customer_email, NEW.customer_phone, 'booking')
    RETURNING id INTO v_contact_id;
  END IF;

  NEW.contact_id := v_contact_id;

  SELECT name, location_id
    INTO v_event_name, v_event_location_id
    FROM event_types
   WHERE id = NEW.event_type_id;

  v_location_id := COALESCE(v_event_location_id, NEW.location_id);

  SELECT id INTO v_deal_id
    FROM deals
   WHERE contact_id = v_contact_id
     AND status = 'open'
   LIMIT 1;

  IF v_deal_id IS NULL THEN
    -- PIPELINE5: deals.stage_id -> pipeline_stages (per location).
    -- Resolve the active "New Lead" entry stage for this location.
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
