-- 273_backfill_event_contact_names.sql
-- Backfill first_name / last_name for contacts created by the public
-- event / race signup flow.
--
-- BUG: findOrCreateRaceContact (src/lib/race-contact-linking.js)
-- inserted only the combined `name`, leaving first_name/last_name
-- NULL. The contact edit form and the "Create in Glofox" gate both
-- read first_name/last_name, so these contacts showed blank name
-- fields and could not be pushed to Glofox. The code fix splits the
-- name at insert going forward; this backfills the rows already
-- created that way.
--
-- Scope: only event/race signup ('race_signup') + the rare
-- booking-trigger contact ('booking') that have a real `name` but no
-- first_name. The 8k+ 'manual' (Glofox-sync) contacts already carry
-- first/last and are untouched. Split mirrors splitName(): first
-- whitespace token -> first_name, the rest -> last_name (NULL when the
-- name is a single token, or when name == email).

update public.contacts
set
  first_name = (regexp_split_to_array(btrim(name), '\s+'))[1],
  last_name  = nullif(array_to_string((regexp_split_to_array(btrim(name), '\s+'))[2:], ' '), '')
where source in ('race_signup', 'booking')
  and (first_name is null or btrim(first_name) = '')
  and name is not null
  and btrim(name) <> ''
  and lower(btrim(name)) <> lower(btrim(coalesce(email, '')));
