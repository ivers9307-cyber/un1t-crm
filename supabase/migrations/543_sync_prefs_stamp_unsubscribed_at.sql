-- 543 — sync_contact_location_preferences() stamps unsubscribed_at.
--
-- THE DEFECT
-- ──────────
-- contact_location_preferences.unsubscribed_at had exactly one writer in the
-- whole codebase: applyFormMarketingConsent (src/lib/marketing-consent.js:111).
-- Neither /api/unsubscribe/[token] nor /api/preferences/[token] ever set it —
-- they write email_marketing=false and updated_at and stop.
--
-- Live proof (2026-08-14): contact 89baf468-7998-4cc7-a26e-017f05dccff1
-- unsubscribed via Postmark one-click on 2026-08-10 23:00:49. consent_log has
-- the row. contact_location_preferences.email_marketing is false. And
-- unsubscribed_at is NULL — so every screen that answers "did this person
-- unsubscribe, and when?" from that column said no. A real customer complaint
-- was investigated as unfounded on the strength of it.
--
-- WHY THE TRIGGER AND NOT THE ROUTES
-- ──────────────────────────────────
-- Three writers reach this table today (the two consent routes via the mig 489
-- fan-out, marketing-consent.js directly, and from mig 544 the ClassPass
-- trigger). Stamping in each is three chances to forget. The sync trigger is
-- already the single choke point every global change flows through.
--
-- SEMANTICS, pinned deliberately
-- ──────────────────────────────
-- One column, three marketing channels — so it needs a rule. It tracks
-- EMAIL: stamped when email_marketing goes true→false, cleared when it goes
-- false→true. That matches its only existing reader (list-health / "when did
-- they leave") and the question it exists to answer. A pre-existing stamp is
-- never overwritten by a later opt-out, so the column means FIRST left, not
-- most recently touched.
--
-- UNCHANGED FROM MIG 489: every other line of this function. The three
-- per-channel fan-out blocks and the own-location mirror keep their exact
-- semantics; only the unsubscribed_at bookkeeping is new.
--
-- SECURITY DEFINER AND search_path ARE PRESERVED VERBATIM, NOT TIDIED.
-- Checked against the live catalogue before writing this (pg_proc.prosecdef =
-- true, proconfig = search_path=public). CREATE OR REPLACE does NOT inherit
-- either property — omit them and the function silently becomes SECURITY
-- INVOKER, at which point the fan-out runs with the CALLER's rights and RLS on
-- contact_location_preferences applies to it.
--
-- That failure is SILENT, which is why it is called out here rather than left
-- to review. Table grants are wide (authenticated and anon both hold INSERT and
-- UPDATE), so nothing would raise. The single permissive FOR ALL policy is
-- `private.auth_is_in_location(location_id)` for authenticated, and anon has no
-- policy at all — so under INVOKER the fan-out UPDATE would simply match ZERO
-- ROWS for any caller outside that location, report success, and leave the
-- person subscribed. An opt-out that returns 200 and changes nothing is the
-- exact defect this migration exists to make visible.
--
-- Widening search_path to 'pg_catalog, public' is likewise NOT a free tidy-up
-- inside a DEFINER function — it changes name resolution under a privileged
-- security context, which is the thing that pin exists to hold still.

create or replace function public.sync_contact_location_preferences()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  own_location uuid;
begin
  select location_id into own_location from contacts where id = new.contact_id;

  if coalesce(new.email_marketing, true) = false then
    update contact_location_preferences
       set email_marketing = false,
           unsubscribed_at = coalesce(unsubscribed_at, now()),
           updated_at = now()
     where contact_id = new.contact_id and email_marketing is distinct from false;
  end if;

  if coalesce(new.sms_marketing, true) = false then
    update contact_location_preferences
       set sms_marketing = false, updated_at = now()
     where contact_id = new.contact_id and sms_marketing is distinct from false;
  end if;

  if coalesce(new.whatsapp_marketing, true) = false then
    update contact_location_preferences
       set whatsapp_marketing = false, updated_at = now()
     where contact_id = new.contact_id and whatsapp_marketing is distinct from false;
  end if;

  if own_location is not null then
    update contact_location_preferences
       set email_marketing    = coalesce(new.email_marketing, true),
           sms_marketing      = coalesce(new.sms_marketing, true),
           whatsapp_marketing = coalesce(new.whatsapp_marketing, true),
           unsubscribed_at    = case
                                  when coalesce(new.email_marketing, true) = false
                                    then coalesce(unsubscribed_at, now())
                                  else null
                                end,
           updated_at         = now()
     where contact_id = new.contact_id
       and location_id = own_location
       and (email_marketing    is distinct from coalesce(new.email_marketing, true)
         or sms_marketing      is distinct from coalesce(new.sms_marketing, true)
         or whatsapp_marketing is distinct from coalesce(new.whatsapp_marketing, true));
  end if;

  return new;
end;
$function$;

comment on function public.sync_contact_location_preferences() is
  'Fans a global contact_preferences marketing change out to contact_location_preferences. mig 543 added the unsubscribed_at stamp: set when email_marketing goes false (coalesced, so it records when they FIRST left), cleared on re-subscribe.';

-- ── Backfill ────────────────────────────────────────────────────────────────
-- Rows that already went false with no stamp. consent_log carries the exact
-- moment where a row exists, so prefer it; updated_at is the fallback proxy.
--
-- Deliberately NOT wrapped in a transitional guard: the column is nullable and
-- currently NULL for every route-driven opt-out in the table, so this is a
-- one-way fill of missing data, not a restatement of anything.
update contact_location_preferences clp
   set unsubscribed_at = coalesce(
         (select max(l.created_at) from consent_log l
           where l.contact_id = clp.contact_id
             and l.channel = 'email_marketing'
             and l.action = 'opt_out'),
         clp.updated_at)
 where clp.email_marketing = false
   and clp.unsubscribed_at is null;
