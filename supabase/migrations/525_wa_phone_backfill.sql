-- WAPHONE-BACKFILL.1 — populate contacts.wa_phone from contacts.phone where
-- it is SAFE to do so.
--
-- Why: WhatsApp broadcasts read wa_phone, never phone. 2,337 contacts (27% of
-- the base) carried a phone with no wa_phone and were silently skipped by
-- every broadcast — not opted out, not undeliverable, just invisible. Found
-- when a sale WhatsApp to 153 offer-clickers excluded 26 for "no WhatsApp
-- number", 10 of whom had a perfectly good mobile on file.
--
-- The rules below are deliberately conservative. A wrong number here is not
-- a no-op: it either burns a paid template send on a stranger or gets the
-- contact marked wa_status='undeliverable', which removes them from future
-- sends. Rejected outright:
--
--   * '+10000000000' — a PLACEHOLDER sitting on 1,620 contacts (19% of the
--     base, one identical value, almost certainly an import/Glofox default).
--     This is the single biggest reason the gap looked so large.
--   * Irish landlines (353 not followed by a mobile prefix 8[35679]) and UK
--     landlines (44 not followed by 7) — WhatsApp is mobile-only in practice.
--   * Repeated-digit junk ('+0000000'), stubs, anything outside 9..15 digits.
--   * BARE FOREIGN NUMBERS with no explicit international marker. '(317)
--     427-8753' is a US national number; stored as digits it becomes
--     '3174278753', which WhatsApp would read as a Dutch (+31) number and
--     deliver to a stranger. 125 rows rejected on this rule alone. A number
--     is only trusted as international if the source string carried '+' or
--     '00', or it is an unambiguous bare Irish/UK mobile.
--
-- Format matches the 6,013 existing rows and normalizeWaPhone() in
-- src/lib/whatsapp-coexistence.js: DIGITS ONLY, no '+' ('353830000000').
--
-- Duplicates: 17 candidate numbers appear on more than one contact. The
-- estate already has 303 such numbers across 641 contacts, so this is not a
-- new class of problem, but the backfill does not add to it — DISTINCT ON
-- assigns each number to the most recently updated contact only.
--
-- The function is left in place deliberately: every Glofox import re-creates
-- this gap, so the backfill is re-runnable with a one-line UPDATE.

create schema if not exists private;

create or replace function private.wa_phone_from_phone(raw text)
returns text
language plpgsql
immutable
as $$
declare
  d text;
  explicit_intl boolean;
  was_irish_local boolean;
begin
  if raw is null or btrim(raw) = '' then return null; end if;

  explicit_intl := raw ~ '^\s*(\+|00)';
  d := regexp_replace(raw, '[^0-9]', '', 'g');
  if d like '00%' then d := substring(d from 3); end if;

  -- Irish national mobile (087…) → E.164 digits (35387…). Unambiguous: this
  -- is the home market and the prefix set is fixed.
  was_irish_local := d ~ '^08[35679][0-9]{7}$';
  if was_irish_local then d := '353' || substring(d from 2); end if;

  if d = '10000000000' then return null; end if;          -- placeholder
  if d ~ '^(.)\1+$' then return null; end if;             -- 0000000 etc
  if d like '0%' then return null; end if;                -- still national
  if length(d) < 9 or length(d) > 15 then return null; end if;
  if d like '353%' and d !~ '^3538[35679][0-9]{7}$' then return null; end if; -- IE landline
  if d like '44%'  and d !~ '^447[0-9]{9}$'         then return null; end if; -- UK landline

  -- Only trust a country code we can actually justify.
  if explicit_intl
     or was_irish_local
     or d ~ '^3538[35679][0-9]{7}$'
     or d ~ '^447[0-9]{9}$'
  then
    return d;
  end if;
  return null;
end;
$$;

comment on function private.wa_phone_from_phone(text) is
  'WAPHONE-BACKFILL.1 — contacts.phone → wa_phone (digits, no +) when safe. NULL when the number is a placeholder, landline, junk, or a bare foreign national number whose country code cannot be trusted. Re-runnable after each import.';

with candidate as (
  select distinct on (private.wa_phone_from_phone(phone))
         id, private.wa_phone_from_phone(phone) as wa
  from contacts
  where (wa_phone is null or wa_phone = '')
    and private.wa_phone_from_phone(phone) is not null
    -- never mint a number another contact already answers on
    and not exists (
      select 1 from contacts x where x.wa_phone = private.wa_phone_from_phone(contacts.phone)
    )
  order by private.wa_phone_from_phone(phone), updated_at desc nulls last
)
update contacts c
set wa_phone = cand.wa, updated_at = now()
from candidate cand
where c.id = cand.id;
