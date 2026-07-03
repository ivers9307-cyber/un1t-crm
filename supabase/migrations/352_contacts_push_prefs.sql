-- 352 — contacts.push_prefs: per-category customer push-notification
-- preferences for the champ-app native app.
--
-- RENUMBERED 350 → 352: PRs #762 (FUNNEL.1) and #763 (this file) merged
-- within the hour and both claimed 350. Applied to prod under its
-- timestamp-keyed history name, so DB-side nothing changes — repo hygiene
-- only, same precedent as the 348→349 renumber (commit 5b42c65e).
--
-- Shape: JSONB of channel-id → boolean, e.g. {"social": false}. The keys are
-- the Android channel ids from shared/customer-push-channels.js
-- ('reminders' | 'social' | 'progress') — the same key BOTH servers'
-- src/lib/customer-push.js derives per payload via
-- customerAndroidChannelId(data.type), so the channel ids double as the pref
-- keys. The 'default' channel (unknown payload types) always sends and is
-- never a preference key.
--
-- Semantics: ABSENT KEY = ENABLED (opt-out model). Nothing is backfilled:
-- every existing member keeps the default '{}' = all categories on, matching
-- current behaviour with no operator action. Enforcement is server-side in
-- sendCustomerPush (recipients with prefs[channel] === false are dropped and
-- counted as skipped) — Android channel muting is device-local and iOS has no
-- channels, so this column is the cross-platform source of truth.
--
-- Writes go through the authed champ-app route GET/PUT /api/notification-prefs
-- (service client, contact resolved from the session) — NOT a customer UPDATE
-- policy on contacts, which carries staff-only fields.
--
-- Additive + fully reversible (drop the column).

alter table public.contacts
  add column if not exists push_prefs jsonb not null default '{}'::jsonb;

comment on column public.contacts.push_prefs is
  'Per-category customer push preferences (mig 352): JSONB of channel-id → boolean, keys = shared/customer-push-channels.js ids (reminders|social|progress). Absent key = enabled (opt-out model, no backfill). Enforced server-side in both repos'' sendCustomerPush; the default channel always sends. Written only via champ-app /api/notification-prefs.';
