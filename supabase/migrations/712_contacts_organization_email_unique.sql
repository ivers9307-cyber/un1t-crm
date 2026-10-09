-- 712 — W0.6: contact email is unique per ORGANISATION, not platform-wide.
--
-- WHY. mig 008's contacts_email_unique (email) WHERE email IS NOT NULL was
-- global: a second gym could not hold a contact whose email existed at
-- another tenant, public forms silently dropped that person (restrictToOrg
-- refuses cross-org links), and POST /api/contacts echoed the raw unique
-- violation — an existence oracle across tenants.
--
-- WHAT. (1) contacts.organization_id, trigger-maintained from the row's
-- location (locations.organization_id, NOT NULL since mig 079), backfilled.
-- (2) the unique index becomes (organization_id, email). (3) the audience
-- send-path view gains the column (mig 689 rule: a new contacts column
-- must reach contact_location_audience, appended at the END). (4) the
-- public booking trigger (mig 336) matches an existing contact across the
-- booking's ORGANISATION, so a sibling-studio contact never collides on
-- insert. Safe before the code deploys.

alter table public.contacts
  add column if not exists organization_id uuid references public.organizations(id);

create or replace function private.contacts_set_organization_id()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.location_id is null then
    new.organization_id := null;
  else
    select organization_id into new.organization_id from public.locations where id = new.location_id;
  end if;
  return new;
end $$;

drop trigger if exists contacts_set_organization_id on public.contacts;
create trigger contacts_set_organization_id
  before insert or update of location_id on public.contacts
  for each row execute function private.contacts_set_organization_id();

update public.contacts c
   set organization_id = l.organization_id
  from public.locations l
 where l.id = c.location_id and c.organization_id is distinct from l.organization_id;

create index if not exists contacts_organization_id_idx on public.contacts (organization_id);

drop index if exists public.contacts_email_unique;
create unique index if not exists contacts_email_org_unique
  on public.contacts (organization_id, email) where email is not null;

comment on column public.contacts.organization_id is
  'W0.6 (mig 712) — denormalised from locations.organization_id by trigger; never written by app code.';

-- (3) The view: mig 705's columns unchanged and in order, then organization_id.
CREATE OR REPLACE VIEW public.contact_location_audience WITH (security_invoker = on) AS
SELECT
  c.id, c.name, c.first_name, c.last_name, c.email, c.phone, c.label, c.glofox_member_id,
  c.trial_credits_remaining, c.lead_source, c.lead_created_at, c.created_at, c.updated_at,
  c.source, c.location_id, c.last_emailed_at, c.total_emails_sent, c.total_emails_opened,
  c.total_emails_clicked, c.email_status, c.tags, c.wa_phone, c.wa_status, c.last_wa_message_at,
  c.total_wa_sent, c.total_wa_received, c.sms_status, c.created_via_import_id, c.user_id,
  c.max_hr_override, c.hr_post_class_emails_enabled, c.glofox_membership_status,
  c.glofox_synced_at, c.dob, c.joined_at, c.last_booked_at, c.last_attended_at,
  c.total_bookings_30d, c.total_attended_30d, c.total_noshow_30d, c.recent_bookings,
  c.lifetime_value_cents, c.lifetime_transaction_count, c.lifetime_currency, c.last_payment_at,
  c.last_invoice_at, c.total_attended_7d, c.pipeline_stage_slug, c.email_marketing,
  c.glofox_membership_plan, c.glofox_membership_state, c.glofox_membership_expiry,
  c.glofox_membership_price_cents, c.glofox_billing_interval, c.glofox_payment_method,
  c.glofox_membership_type, c.glofox_image_url, c.gender, c.emergency_contact,
  c.glofox_signup_answers, c.glofox_roaming_enabled, c.glofox_account_active, c.glofox_source,
  c.glofox_membership_plan_full, c.first_class_checkin_at, c.person_group_id,
  c.email_administrative, c.weight_kg, c.weight_kg_source, c.weight_kg_at,
  c.profile_setup_completed_at, c.whatsapp_marketing, c.is_primary_contact, c.ctwa_clid,
  c.ctwa_clid_at, c.converted_at, c.hr_leaderboard_opt_out, c.push_prefs, c.pack_customer_at,
  c.utm_campaign, c.utm_content, c.utm_term, c.ad_provider, c.ad_external_id, c.attributed_at,
  c.pipeline_dismissed_at, c.email_suppressed_at, c.wa_bsuid, c.last_marketing_touch_at,
  c.glofox_membership_paused_at, c.glofox_membership_resume_at, c.gympass_member_id,
  c.automations_exempt,
  clp.location_id AS audience_location_id,
  clp.email_marketing AS loc_email_marketing,
  clp.sms_marketing AS loc_sms_marketing,
  clp.whatsapp_marketing AS loc_whatsapp_marketing,
  c.last_email_open_at, c.last_email_click_at, c.email_hygiene_released_at,
  c.instagram_igsid, c.instagram_handle, c.name_normalized, c.last_lead_source,
  c.last_lead_source_at, c.glofox_user_membership_id, c.glofox_detail_due_at,
  c.visit_referrer, c.visit_landing_path, c.visit_captured_at, c.organization_id
FROM public.contacts c
JOIN public.contact_location_preferences clp ON clp.contact_id = c.id;

-- Mig 662's state, restated (a no-op today; required after any statement
-- that creates this view).
REVOKE ALL ON public.contact_location_audience FROM anon, authenticated, PUBLIC;

-- Self-check against the catalog, never this file (mig 153's lesson).
DO $$
DECLARE
  v_n int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class c
                  WHERE c.oid = 'public.contact_location_audience'::regclass AND c.relkind = 'v'
                    AND c.reloptions @> ARRAY['security_invoker=on']) THEN
    RAISE EXCEPTION 'mig 712: contact_location_audience is not a security_invoker view';
  END IF;
  SELECT count(*) INTO v_n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'contact_location_audience'
     AND column_name = 'organization_id';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'mig 712: expected organization_id on the view, found %', v_n;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.role_table_grants
              WHERE table_schema = 'public' AND table_name = 'contact_location_audience'
                AND grantee IN ('anon', 'authenticated', 'PUBLIC')) THEN
    RAISE EXCEPTION 'mig 712: a client role holds a privilege on contact_location_audience';
  END IF;
END $$;

-- (4) The booking trigger: mig 596's body verbatim, except the contact match
-- now reaches any location in the booking's ORGANISATION. Under the global
-- index a sibling-studio contact made the INSERT below 23505 and failed the
-- customer's booking; under the per-org index it would create a duplicate
-- person inside the tenant. A contact at the booking's own location still
-- wins; a legacy unscoped contact is still allowed; another tenant's never.
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

  -- W0.6 (mig 712): case-insensitive match at this location, else a legacy
  -- unscoped contact, else a sibling location in the same ORGANISATION;
  -- never a contact known to live in another organisation.
  SELECT c.id INTO v_contact_id
  FROM contacts c
  LEFT JOIN locations l ON l.id = c.location_id
  WHERE lower(c.email) = lower(NEW.customer_email)
    AND (c.location_id = v_location_id
         OR c.location_id IS NULL
         OR l.organization_id = (SELECT organization_id FROM locations WHERE id = v_location_id))
  ORDER BY (c.location_id = v_location_id) DESC NULLS LAST, c.created_at ASC
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
  if not exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'contacts' and indexname = 'contacts_email_org_unique') then
    raise exception 'mig 712: contacts_email_org_unique is missing';
  end if;
  if exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'contacts' and indexname = 'contacts_email_unique') then
    raise exception 'mig 712: the global contacts_email_unique index is still present';
  end if;
  if exists (select 1 from public.contacts where location_id is not null and organization_id is null) then
    raise exception 'mig 712: a located contact has no organization_id after the backfill';
  end if;
  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.contacts'::regclass
       and tgname = 'contacts_set_organization_id'
       and tgenabled <> 'D'
  ) then
    raise exception 'mig 712: contacts_set_organization_id trigger is missing or disabled';
  end if;
  v_def := pg_get_functiondef('public.handle_new_booking'::regproc);
  if v_def not ilike '%l.organization_id%' then
    raise exception 'mig 712: handle_new_booking does not match across the organisation';
  end if;
  if v_def not ilike '%pipeline_id%' then
    raise exception 'mig 712: handle_new_booking lost PIPELINES.5b';
  end if;
end $$;
