-- GYMPASS.2 — off-funnel "Gympass" pipeline stage (Richard, 2026-07-20).
--
-- Gympass/Wellhub users are pulled OUT of the sellable funnel into their own
-- off-funnel pile: classifyContact() returns 'gympass' for any contact with a
-- synced gympass_member_id (metadata.gympass.id, mig 429) that isn't already a
-- paying member (a real membership outranks Gympass, so a converting Gympass
-- user graduates to the Member category — the Glofox profile is shared).
--
-- Every location that carries the standard stage set needs the row, or the
-- classifier falls back to 'new_lead' and the user lands back in the funnel
-- (the mig 150 incident class). This mirrors the ClassPass off-funnel stage;
-- NEW locations get it automatically via src/lib/location-seed.js (STAGE_DETAILS).
--
-- Idempotent: ON CONFLICT on the (location_id, slug) unique index.
insert into public.pipeline_stages (location_id, slug, name, display_order, color, is_dormant, archived)
select distinct location_id, 'gympass', 'Gympass', 311, '#F97316', true, false
from public.pipeline_stages
where slug = 'classpass' and archived = false
on conflict (location_id, slug) do nothing;
