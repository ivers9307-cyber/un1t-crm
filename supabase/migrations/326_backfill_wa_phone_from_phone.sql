-- 326 — backfill contacts.wa_phone from contacts.phone for valid Irish mobiles
-- (Stillorgan), so Glofox-imported contacts become WhatsApp-reachable.
--
-- WHY: wa_phone (Meta E.164, no '+') was only ever populated by an actual
-- WhatsApp interaction (inbound webhook / inbox "start conversation"), never
-- derived from the imported `phone`. So 8,169 Stillorgan contacts had a phone
-- but no wa_phone and showed as "no WhatsApp number" in broadcast reachability
-- (mig 422 / WA-REACH) — only 4 of 8,303 contacts were WhatsApp-reachable.
--
-- Normalisation mirrors src/lib/glofox-sync.js#normalizePhone (then strips '+'
-- to match the wa_phone format the inbox webhook stores):
--   strip non-digits; drop a leading "00" international prefix; accept ONLY IE
--   mobiles —
--     353 8[35679] +7 digits   (already E.164)            -> keep
--     0   8[35679] +7 digits   (national 0-trunk, 10 dig) -> drop leading 0, prepend 353
--         8[35679] +7 digits   (9-digit, no trunk)        -> prepend 353
--   UK (+44), IE landlines, foreign numbers, the +10000000000 placeholder, and
--   malformed/short entries are left NULL (a send to a non-WhatsApp number just
--   fails harmlessly; we don't guess).
--
-- Only fills NULL/'' wa_phone (never overwrites a real one), Stillorgan only —
-- idempotent and re-runnable. Dry-run before applying: 5,905 rows backfilled,
-- 221 UK / 115 IE-landline / 1,915 foreign-or-junk / 13 empty left NULL.
--
-- NB: this does NOT add a forward mechanism — new Glofox imports still won't
-- derive wa_phone, so the gap reopens for future contacts (separate follow-up).
-- It also surfaces duplicate contacts sharing one number (e.g. the 3 "Richard
-- Ivers" rows) as multiple reachable recipients — see the contact-merge follow-up.

UPDATE contacts c
SET wa_phone = sub.wa
FROM (
  SELECT id,
    CASE
      WHEN d ~ '^3538[35679][0-9]{7}$' THEN d
      WHEN d ~ '^08[35679][0-9]{7}$'   THEN '353' || substr(d, 2)
      WHEN d ~ '^8[35679][0-9]{7}$'    THEN '353' || d
    END AS wa
  FROM (
    SELECT id,
      CASE
        WHEN regexp_replace(phone, '[^0-9]', '', 'g') LIKE '00%'
          THEN substr(regexp_replace(phone, '[^0-9]', '', 'g'), 3)
        ELSE regexp_replace(phone, '[^0-9]', '', 'g')
      END AS d
    FROM contacts
    WHERE location_id = 'a0000000-0000-0000-0000-000000000001'
      AND phone IS NOT NULL AND phone <> ''
      AND (wa_phone IS NULL OR wa_phone = '')
  ) norm
) sub
WHERE c.id = sub.id
  AND sub.wa IS NOT NULL;
