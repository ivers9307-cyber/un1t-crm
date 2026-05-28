-- STUDIO-AC-GROUPS.1 — add a free-text device_group column to
-- ac_devices so the AC control panel can render one section per
-- group (e.g. 'Gym Floor', 'Bathrooms', 'Office'). Master edits
-- the group on each device from the AC Devices settings tab.
--
-- Applied via Supabase MCP on 2026-05-28.

alter table public.ac_devices
  add column if not exists device_group text;

-- Backfill sensible defaults. Sensibo → Gym Floor (the existing
-- studio-floor unit at every location); ThinQ → Bathrooms (the
-- common-case use for the LG integration). Operators re-categorise
-- non-bathroom LG units (office, physio, etc.) from the settings UI.
update public.ac_devices
   set device_group = 'Gym Floor'
 where provider = 'sensibo' and device_group is null;

update public.ac_devices
   set device_group = 'Bathrooms'
 where provider = 'thinq' and device_group is null;

comment on column public.ac_devices.device_group is
  'STUDIO-AC-GROUPS.1 — free-text grouping label rendered as the '
  'section header in the AC control panel. Default at backfill: '
  'Gym Floor for sensibo, Bathrooms for thinq. Master-editable from '
  'the AC Devices settings tab.';
