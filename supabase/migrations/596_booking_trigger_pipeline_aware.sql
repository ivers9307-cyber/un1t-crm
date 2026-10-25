-- PIPELINES.5b — handle_new_booking() becomes board-aware.
--
-- The SIXTH deal-insert site, and the only one in SQL. Found during PIPELINES.5
-- by reading pg_proc, not the codebase — no amount of code review would have
-- surfaced it. booking_created_trigger on public.bookings is live and enabled
-- (tgenabled='O'), and the function had three defects, each biting at a
-- different moment:
--
--   1. It inserted deals with NO pipeline_id. The reclassify orchestrator now
--      scopes its deal read with `.in('pipeline_id', …)`, and SQL IN never
--      matches NULL — so a booking-created deal is invisible to the next cron
--      run, which creates ANOTHER open deal for that contact, whose insert is
--      also null, duplicating every night, unbounded.
--
--   2. It hardcoded `slug = 'new_lead'` for the entry column. UN1T Hatch
--      Street's waitlist board has no such slug. Once its gym stages are
--      archived, a Hatch booking would have inserted a deal with a NULL
--      stage_id — a deal that renders on no column at all.
--
--   3. Its "does this contact already have an open deal?" probe was unscoped,
--      so with two boards it would find a deal on the OTHER board and then
--      silently create nothing for the board that needed one.
--
-- And it would have hard-failed outright once pipeline_id goes NOT NULL.
--
-- Everything else is preserved verbatim: the location resolution, the
-- case-insensitive location-scoped contact match (which deliberately allows a
-- legacy unscoped contact but never one known to live elsewhere), the name
-- splitting, and the activities insert.
--
-- A BOOKING MAY CREATE A DEAL ON A MANUAL BOARD, and that is correct. The rule
-- is that automatic ENTRY into column 1 is allowed — it is exactly how the
-- waitlist form works — while automatic MOVEMENT is not. v_pipeline_mode is
-- selected so a later reader can see the distinction was considered; it
-- deliberately does not gate the insert.
--
-- The whole deal block is now conditional. A location with no enabled primary
-- board creates no deal, and the booking still succeeds with its contact and
-- activity intact. Removing a silent failure must never create a louder one:
-- losing a bookkeeping row is strictly better than failing a customer's
-- booking.

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
  v_pipeline_id UUID;
  v_pipeline_mode TEXT;
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

  -- PIPELINES.5b — resolve the location's primary board, then work within it.
  SELECT id, mode INTO v_pipeline_id, v_pipeline_mode
    FROM pipelines
   WHERE location_id = v_location_id
     AND is_primary
     AND enabled
   LIMIT 1;

  IF v_pipeline_id IS NOT NULL THEN
    -- Scoped to the board. An unscoped probe finds a deal on ANY board and
    -- then silently creates nothing for the board we actually care about.
    SELECT id INTO v_deal_id
      FROM deals
     WHERE contact_id = v_contact_id
       AND status = 'open'
       AND pipeline_id = v_pipeline_id
     LIMIT 1;

    IF v_deal_id IS NULL THEN
      -- Entry column = lowest live display_order on THAT board, never a
      -- hardcoded slug: a manual board does not carry the acquisition
      -- funnel's, so the old lookup would insert a null stage_id that renders
      -- on no column at all.
      -- archived=false is load-bearing — mig 239 archived nine legacy stages
      -- still sitting at display_order 1-9, which would otherwise win the sort.
      SELECT id INTO v_stage_id
        FROM pipeline_stages
       WHERE pipeline_id = v_pipeline_id
         AND archived = false
       ORDER BY display_order
       LIMIT 1;

      IF v_stage_id IS NOT NULL THEN
        INSERT INTO deals (contact_id, title, status, stage_id, location_id, pipeline_id)
        VALUES (
          v_contact_id,
          'Booked: ' || COALESCE(v_event_name, 'Event'),
          'open',
          v_stage_id,
          v_location_id,
          v_pipeline_id
        )
        RETURNING id INTO v_deal_id;
      END IF;
    END IF;
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

-- Count, don't trust.
do $$
declare
  v_def text;
begin
  v_def := pg_get_functiondef('public.handle_new_booking'::regproc);
  if v_def not ilike '%pipeline_id%' then
    raise exception 'PIPELINES.5b: handle_new_booking does not reference pipeline_id';
  end if;
  if v_def ilike '%new_lead%' then
    raise exception 'PIPELINES.5b: handle_new_booking still hardcodes the new_lead slug';
  end if;
  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.bookings'::regclass
       and tgname = 'booking_created_trigger'
       and tgenabled <> 'D'
  ) then
    raise exception 'PIPELINES.5b: booking_created_trigger is missing or disabled';
  end if;
end $$;
