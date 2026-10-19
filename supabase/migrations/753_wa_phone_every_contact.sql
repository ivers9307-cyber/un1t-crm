-- 753 — WAPHONE.1: every contact's phone maps to a WhatsApp number.
--
-- THE GAP
-- ───────
-- contacts.wa_phone (E.164 digits, no '+') is what every WhatsApp sender reads;
-- sequences skip "contact has no WhatsApp phone number" without it. Mig 330's
-- trigger derive_wa_phone_trigger (BEFORE INSERT OR UPDATE OF phone) already
-- runs on every write path (staff create, lead forms, race signups, imports,
-- the Glofox and un1t.online syncs: none of them can skip a trigger), but the
-- rule it called, normalize_ie_wa_phone, knew IRISH MOBILES ONLY. On 19 Oct
-- 2026, 399 contacts with a phone had no wa_phone (Hatch 32 of 213, Stillorgan
-- 367 of 6,816), of which 138 are real WhatsApp numbers the rule did not know:
--   * 95  Irish mobiles stored as 3530 8X… (country code + trunk zero, no '+')
--   * 20  UK mobiles written +44 7…, 8 UK mobiles written 07…
--   * 13  other international numbers written with '+' (Ukraine, Malta, …)
--   * 2   Irish mobiles written +353 8X…
-- and a phone CHANGE never re-derived: the trigger filled only an EMPTY
-- wa_phone, so a contact whose number changed kept WhatsApping the old one.
--
-- THE RULE (public.normalize_wa_phone; src/lib/phone-validate.js
-- waPhoneFromPhone is the same rule, pinned by
-- tests/wa-phone-normaliser-parity.test.js over one fixture table)
--   * Irish mobile in any spelling (08X, 8X, 3538X, +353 8X, 00353 8X; X 3-9)
--   * UK mobile (07 + 9, 447 + 9, +44 7)
--   * 3530… / 440… repaired to 353… / 44… (no national number starts 0)
--   * anything else written with '+' or '00': 8-15 digits, country code not 0,
--     not one repeated digit, +1 must be a real NANP shape (kills the ClassPass
--     '+10000000000' placeholder)
--   * NULL for: Irish/UK landlines and lo-call (as before), letters (emails in
--     the phone field), and bare foreign digits with no '+'/'00' (mig 525: a US
--     national number stored as digits reads as a Dutch +31 one).
--
-- THE TRIGGER (public.derive_wa_phone, same trigger, new body)
--   * empty wa_phone → derived from the phone (as before, wider rule);
--   * UPDATE that changes the phone, leaves wa_phone untouched, and whose
--     wa_phone WAS the old phone's derivation → re-derived from the new phone
--     (only when the new phone maps; an unmappable new phone keeps the old
--     number rather than going dark);
--   * a wa_phone that differs from the old phone's derivation (learned from an
--     inbound WhatsApp, or set by staff) is NEVER overwritten, and neither is a
--     wa_phone the same statement sets explicitly.
--
-- THE BACKFILL fills an EMPTY wa_phone only, never overwrites one. No unique
-- index exists on wa_phone (idx_contacts_wa_phone is a plain btree), so no
-- conflict can abort it; but like mig 525 it does not mint a second contact
-- answering on one number at the SAME studio (the duplicate-contact case: the
-- person is already reachable on the other row, and a second row would double
-- every broadcast). Those are skipped and counted. Across studios a shared
-- number is normal (contacts are per studio) and is filled.
--
-- normalize_wa_phone lives in public, not private: the trigger is INVOKER and
-- service_role (every /api route) has no USAGE on schema private, so a private
-- helper would fail every contacts write from a route. Closed to clients per
-- mig 667 (contacts is read-only for client sessions, mig 653).
--
-- Applied by the controller before merge. Idempotent: a second run fills
-- nothing and passes its self-check. Fictional values only: the repo is public.

begin;

create or replace function public.normalize_wa_phone(raw text)
returns text
language plpgsql
immutable
parallel safe
set search_path = ''
as $function$
declare
  d    text;
  intl boolean;
begin
  if raw is null or raw !~ '[0-9]' then return null; end if;
  if raw ~ '[A-Za-z]' then return null; end if;
  d := regexp_replace(raw, '[^0-9]', '', 'g');
  -- International when the first digit-or-plus is '+', or the digits open 00.
  intl := coalesce(substring(raw from '[0-9+]') = '+', false) or d like '00%';
  if d like '00%' then d := substr(d, 3); end if;
  if d like '3530%' then d := '353' || substr(d, 5);
  elsif d like '440%' then d := '44' || substr(d, 4);
  end if;
  if not intl then
    if    d ~ '^08[3-9][0-9]{7}$' then d := '353' || substr(d, 2);
    elsif d ~ '^8[3-9][0-9]{7}$'  then d := '353' || d;
    elsif d ~ '^07[0-9]{9}$'      then d := '44' || substr(d, 2);
    end if;
  end if;
  if d = '' then return null; end if;
  if d ~ '^3538[3-9][0-9]{7}$' or d ~ '^447[0-9]{9}$' then return d; end if;
  if d like '353%' or d like '44%' then return null; end if;
  if not intl then return null; end if;
  if d like '0%' then return null; end if;
  if length(d) < 8 or length(d) > 15 then return null; end if;
  if d ~ '^([0-9])\1+$' then return null; end if;
  if d like '1%' and d !~ '^1[2-9][0-9]{2}[2-9][0-9]{6}$' then return null; end if;
  return d;
end;
$function$;

comment on function public.normalize_wa_phone(text) is
  'WAPHONE.1 (mig 753) — a phone as typed or synced → its WhatsApp number (E.164 digits, no +), or NULL. Irish + UK mobiles in any spelling, any +/00 international number of plausible shape; NULL for landlines, letters, placeholders and bare foreign digits. Same rule as waPhoneFromPhone in src/lib/phone-validate.js (parity-tested).';

revoke execute on function public.normalize_wa_phone(text) from public, anon, authenticated;
grant execute on function public.normalize_wa_phone(text) to service_role;

-- CREATE OR REPLACE keeps derive_wa_phone's ACL and the trigger binding.
create or replace function public.derive_wa_phone()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  derived text := public.normalize_wa_phone(new.phone);
begin
  if new.wa_phone is null or btrim(new.wa_phone) = '' then
    new.wa_phone := derived;
  elsif tg_op = 'UPDATE'
    and derived is not null
    and new.phone is distinct from old.phone
    and new.wa_phone is not distinct from old.wa_phone
    and regexp_replace(old.wa_phone, '[^0-9]', '', 'g') = public.normalize_wa_phone(old.phone)
  then
    new.wa_phone := derived;
  end if;
  return new;
end;
$function$;

comment on function public.derive_wa_phone() is
  'BEFORE INSERT OR UPDATE OF phone on contacts (mig 330, rule widened by mig 753): an empty wa_phone is derived from phone via normalize_wa_phone; a phone change re-derives a wa_phone that was the old phone''s derivation; a wa_phone learned elsewhere (inbound WhatsApp, staff) is never overwritten.';

comment on function public.normalize_ie_wa_phone(text) is
  'SUPERSEDED by public.normalize_wa_phone (mig 753); no longer called by derive_wa_phone. Irish mobiles only.';
comment on function private.wa_phone_from_phone(text) is
  'SUPERSEDED by public.normalize_wa_phone (mig 753). Mig 525''s one-off backfill rule.';

-- ── Backfill ────────────────────────────────────────────────────────────────
do $backfill$
declare
  v_missing_before int;
  v_mappable       int;
  v_filled         int;
  v_skipped_dup    int;
  v_left           int;
  v_unmappable     int;
begin
  select count(*) into v_missing_before
    from public.contacts
   where phone is not null and btrim(phone) <> ''
     and (wa_phone is null or btrim(wa_phone) = '');

  select count(*) into v_mappable
    from public.contacts c
   where (c.wa_phone is null or btrim(c.wa_phone) = '')
     and public.normalize_wa_phone(c.phone) is not null;

  with candidate as (
    select c.id, c.location_id, public.normalize_wa_phone(c.phone) as wa, c.updated_at
      from public.contacts c
     where (c.wa_phone is null or btrim(c.wa_phone) = '')
       and public.normalize_wa_phone(c.phone) is not null
  ), free as (
    select k.*
      from candidate k
     where not exists (
       select 1 from public.contacts x
        where x.location_id is not distinct from k.location_id
          and x.id <> k.id
          and x.wa_phone is not null and btrim(x.wa_phone) <> ''
          and regexp_replace(x.wa_phone, '[^0-9]', '', 'g') = k.wa)
  ), pick as (
    -- One contact per (studio, number): the most recently updated.
    select distinct on (location_id, wa) id, wa
      from free
     order by location_id, wa, updated_at desc nulls last, id
  )
  update public.contacts c
     set wa_phone = pick.wa
    from pick
   where c.id = pick.id
     and (c.wa_phone is null or btrim(c.wa_phone) = '');
  get diagnostics v_filled = row_count;
  v_skipped_dup := v_mappable - v_filled;

  -- Self-check: every contact whose phone maps now has a wa_phone, unless
  -- another contact at the same studio already answers on that number.
  select count(*) into v_left
    from public.contacts c
   where (c.wa_phone is null or btrim(c.wa_phone) = '')
     and public.normalize_wa_phone(c.phone) is not null
     and not exists (
       select 1 from public.contacts x
        where x.location_id is not distinct from c.location_id
          and x.id <> c.id
          and x.wa_phone is not null and btrim(x.wa_phone) <> ''
          and regexp_replace(x.wa_phone, '[^0-9]', '', 'g') = public.normalize_wa_phone(c.phone));
  if v_left <> 0 then
    raise exception 'mig 753 self-check: % contact(s) with a mappable phone and no same-studio twin still lack wa_phone', v_left;
  end if;

  select count(*) into v_unmappable
    from public.contacts
   where phone is not null and btrim(phone) <> ''
     and (wa_phone is null or btrim(wa_phone) = '')
     and public.normalize_wa_phone(phone) is null;

  raise notice 'mig 753: % contacts had a phone and no wa_phone; % mappable; % filled; % skipped (same-studio duplicate number); % unmappable (landline, letters, placeholder, bare foreign)',
    v_missing_before, v_mappable, v_filled, v_skipped_dup, v_unmappable;
end;
$backfill$;

-- ── Self-check: wiring and ACL ──────────────────────────────────────────────
do $check$
begin
  if not exists (
    select 1 from pg_trigger t
     where t.tgrelid = 'public.contacts'::regclass
       and t.tgname = 'derive_wa_phone_trigger'
       and t.tgfoid = 'public.derive_wa_phone()'::regprocedure
       and t.tgenabled <> 'D')
  then
    raise exception 'mig 753 self-check: derive_wa_phone_trigger is not live on contacts';
  end if;
  if pg_get_functiondef('public.derive_wa_phone()'::regprocedure) not like '%public.normalize_wa_phone(new.phone)%' then
    raise exception 'mig 753 self-check: derive_wa_phone does not call normalize_wa_phone';
  end if;
  if has_function_privilege('anon', 'public.normalize_wa_phone(text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.normalize_wa_phone(text)', 'EXECUTE') then
    raise exception 'mig 753 self-check: normalize_wa_phone is executable by a client role';
  end if;
  if not has_function_privilege('service_role', 'public.normalize_wa_phone(text)', 'EXECUTE') then
    raise exception 'mig 753 self-check: service_role cannot execute normalize_wa_phone (every route''s contacts write would fail)';
  end if;
  if public.normalize_wa_phone('087 123 4567') is distinct from '353871234567'
     or public.normalize_wa_phone('+44 7700 900123') is distinct from '447700900123'
     or public.normalize_wa_phone('3530871234567') is distinct from '353871234567'
     or public.normalize_wa_phone('01 555 1234') is not null
     or public.normalize_wa_phone('+10000000000') is not null then
    raise exception 'mig 753 self-check: normalize_wa_phone spot checks failed';
  end if;
end;
$check$;

commit;
