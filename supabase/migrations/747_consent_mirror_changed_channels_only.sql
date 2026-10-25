-- 747 — sync_contact_location_preferences() acts only on the channels that
-- CHANGED (WAORGNUMBER.3, R6).
--
-- THE DEFECT THIS CLOSES
-- ──────────────────────
-- Since WAORGNUMBER.3 a WhatsApp STOP or START in a thread at studio S writes
-- ONLY contact_location_preferences (contact, S). It no longer writes
-- contact_preferences, because the mig 489 fan-out would turn "stop Hatch
-- Street" into "stop every studio".
--
-- But the trigger below fires AFTER INSERT OR UPDATE on contact_preferences,
-- on ANY column, and its own-location block (mig 489, kept by mig 543) rewrote
-- ALL THREE channels on the home studio's row to the contact_preferences values
-- whenever any of them differed. So:
--   * a member STOPs in a thread at their home studio: the home row's
--     whatsapp_marketing = false, contact_preferences.whatsapp_marketing stays
--     true;
--   * their next contact_preferences write of ANY kind (an email unsubscribe,
--     a staff edit, the preference centre, a bulk import) re-mirrored
--     whatsapp_marketing = true onto the home row, re-subscribing them to
--     WhatsApp marketing in silence.
-- The reverse case: a studio START while contact_preferences.whatsapp_marketing
-- is false (a historic contact-wide STOP) was undone the same way. That is the
-- safe direction, but it still loses a choice the member made.
--
-- THE RULE NOW
-- ────────────
-- A channel's two effects run only on INSERT, or when THAT channel's value
-- changed (NEW.<ch> IS DISTINCT FROM OLD.<ch>):
--   1. -> false fans out to every one of the contact's studio rows (unchanged
--      meaning: a global unsubscribe reaches every studio);
--   2. the own-location mirror sets that channel on the home row.
-- A write that leaves a channel alone no longer touches that channel anywhere.
-- unsubscribed_at keeps mig 543's EMAIL semantics: stamped (coalesced, so it
-- records the FIRST departure) when email goes false, cleared when it goes
-- true, and now left alone when email did not change.
--
-- INSERT mirrors every channel exactly as before (OLD does not exist there).
--
-- ACCEPTED CONSEQUENCE: re-saving a channel to the value it already has no
-- longer re-syncs a studio row that differs. That is the point: the studio row
-- is the per-studio truth, and a contact-wide row that did not change says
-- nothing new about any studio.
--
-- UNCHANGED: the trigger itself (mig 489: AFTER INSERT OR UPDATE ON
-- contact_preferences FOR EACH ROW). CREATE OR REPLACE FUNCTION keeps it bound.
--
-- SECURITY DEFINER AND search_path ARE KEPT VERBATIM (mig 543's warning: CREATE
-- OR REPLACE does not inherit either, and under INVOKER the fan-out UPDATE
-- would match zero rows for a caller outside the location and report success).
-- CREATE OR REPLACE keeps the ACL mig 490 set (postgres + service_role). The
-- REVOKE below restates that decision, so the file is right on a database whose
-- defaults were reset. A trigger needs no EXECUTE grant to fire.

create or replace function public.sync_contact_location_preferences()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  own_location uuid;
  email_changed boolean;
  sms_changed boolean;
  wa_changed boolean;
  new_email boolean := coalesce(new.email_marketing, true);
  new_sms boolean := coalesce(new.sms_marketing, true);
  new_wa boolean := coalesce(new.whatsapp_marketing, true);
begin
  if tg_op = 'INSERT' then
    email_changed := true;
    sms_changed := true;
    wa_changed := true;
  else
    email_changed := new.email_marketing is distinct from old.email_marketing;
    sms_changed := new.sms_marketing is distinct from old.sms_marketing;
    wa_changed := new.whatsapp_marketing is distinct from old.whatsapp_marketing;
  end if;

  if not (email_changed or sms_changed or wa_changed) then
    return new;
  end if;

  select location_id into own_location from contacts where id = new.contact_id;

  -- OFF propagates everywhere, for a channel that changed.
  if email_changed and new_email = false then
    update contact_location_preferences
       set email_marketing = false,
           unsubscribed_at = coalesce(unsubscribed_at, now()),
           updated_at = now()
     where contact_id = new.contact_id and email_marketing is distinct from false;
  end if;

  if sms_changed and new_sms = false then
    update contact_location_preferences
       set sms_marketing = false, updated_at = now()
     where contact_id = new.contact_id and sms_marketing is distinct from false;
  end if;

  if wa_changed and new_wa = false then
    update contact_location_preferences
       set whatsapp_marketing = false, updated_at = now()
     where contact_id = new.contact_id and whatsapp_marketing is distinct from false;
  end if;

  -- The own-location mirror, for the changed channels only. Deliberately does
  -- NOT create a row (mig 489): a global opt-in is not evidence that they
  -- joined that studio's list.
  if own_location is not null then
    update contact_location_preferences
       set email_marketing    = case when email_changed then new_email else email_marketing end,
           sms_marketing      = case when sms_changed   then new_sms   else sms_marketing end,
           whatsapp_marketing = case when wa_changed    then new_wa    else whatsapp_marketing end,
           unsubscribed_at    = case
                                  when not email_changed then unsubscribed_at
                                  when new_email = false then coalesce(unsubscribed_at, now())
                                  else null
                                end,
           updated_at         = now()
     where contact_id = new.contact_id
       and location_id = own_location
       and ((email_changed and email_marketing    is distinct from new_email)
         or (sms_changed   and sms_marketing      is distinct from new_sms)
         or (wa_changed    and whatsapp_marketing is distinct from new_wa));
  end if;

  return new;
end;
$function$;

comment on function public.sync_contact_location_preferences() is
  'Fans a global contact_preferences marketing change out to contact_location_preferences: a channel going false reaches every studio row, and the home studio row mirrors the change. mig 543 added the unsubscribed_at stamp (email). mig 747: only channels whose value CHANGED (or every channel on INSERT) are acted on, so an unrelated write never undoes a per-studio WhatsApp STOP or START.';

revoke execute on function public.sync_contact_location_preferences() from public, anon, authenticated;
