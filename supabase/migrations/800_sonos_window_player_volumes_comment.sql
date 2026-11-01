-- 800 — SONOSPLAYERVOL.1: a Sonos window may name a level per speaker.
--
-- No DDL beyond the comment: `windows` is jsonb and the new key is optional.
-- The shape is recorded here so the column comment keeps describing what
-- the rows hold. Applied after the open sequence (src/lib/sonos/apply.js):
-- group volume, then each named speaker, then the favourite. The group
-- volume stays the default for any speaker not named.

COMMENT ON COLUMN public.sonos_schedules.windows IS
  '[{days:[1..7], on:"06:00", off:"21:30", volume:0-100, favorite_id:"...", player_volumes?:{"RINCON_...":0-100}}]. player_volumes (SONOSPLAYERVOL.1, mig 800) is optional, keyed by the permanent player id, applied after the group volume for the schedule''s own speakers only; volume stays the default for any speaker not named. Consumed by resolveServeWindows in src/lib/schedule/desired-state.js as fixed_windows.';
