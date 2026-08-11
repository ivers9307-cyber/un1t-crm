-- CLASSPASS-PHONE.1 — clear the ClassPass placeholder phone number.
--
-- 1,620 contacts (19% of the base) carried the IDENTICAL fake number
-- '+10000000000'. Confirmed ClassPass in origin: every one has a
-- @members.classpass.com relay address, 1,619 carry lead_source='classpass',
-- and all are Glofox-synced. ClassPass does not share the member's real
-- phone, so Glofox stores a constant filler and it syncs through to us.
--
-- Why it matters: the value is not inert. Anything asking "does this contact
-- have a phone?" counted these 1,620 as reachable — they are not. It is what
-- made the wa_phone gap look four times larger than it was (mig 525), and it
-- would keep skewing any reachability or data-quality count.
--
-- These contacts are ALREADY suppressed where it counts: email_marketing is
-- false on all 1,620 (their address is a relay, not the member's own), and
-- they have no wa_phone, so WhatsApp/SMS broadcasts already skip them. This
-- migration therefore changes no send behaviour. It only stops the data
-- claiming a phone that does not exist.
--
-- Tag first, THEN null: 'classpass-marketplace' records exactly which rows
-- were touched, so the change is fully reversible (the cleared value was a
-- single known constant) and the cohort stays filterable in the audience
-- builder afterwards.
--
-- Deliberately narrow: only the exact literal '+10000000000'. Other junk
-- numbers ('+0000000' and friends, ~100 rows) are NOT touched here — they
-- are unrelated one-offs, not a systematic integration artefact.

insert into contact_tags (contact_id, location_id, tag)
select id, location_id, 'classpass-marketplace'
from contacts c
where c.phone = '+10000000000'
  and not exists (
    select 1 from contact_tags ct
    where ct.contact_id = c.id and ct.tag = 'classpass-marketplace' and ct.removed_at is null
  );

update contacts
set tags = coalesce(tags, '{}') || array['classpass-marketplace']
where phone = '+10000000000'
  and not (coalesce(tags, '{}') @> array['classpass-marketplace']);

update contacts
set phone = null, updated_at = now()
where phone = '+10000000000';
