# Strava direct inbound — unified connection, no OpenWearables

**Date:** 2026-06-23
**Repos:** champ-app (OAuth connect — exists; UI consolidation), un1t-crm (Strava API client, webhook receiver, backfill cron, OW decommission), shared Supabase `iyvtbjjxdggiadzwwvdj`.

## Why

Inbound Strava was built via OpenWearables (OW). It proved unreliable: OW polls + stores Strava activities hourly but **does not emit** the `workout.created` our webhook needs — only a manual historical sync emits, so new activities never reached the app (diagnosed 2026-06-23; only 2 activities ever landed, both hand-pulled). OW is high-maintenance (self-hosted Fly stack + Svix) and its webhook emission is the recurring failure point across this whole program.

Strava, unlike Apple, has a clean public REST API + push webhooks, and **we already run a direct Strava OAuth integration** (the `activity:write` export). So inbound should be **direct** — drop OW for Strava entirely. (OW stays for Apple, handled separately later.)

## Decisions (Richard, 2026-06-23)
- **Unify:** ONE Strava connection per member doing **both** directions — import (`activity:read`) **and** export (`activity:write`, kept; pushes UN1T HR-strap sessions to Strava). One "Connect Strava", one OAuth grant, one token row.
- **Real-time:** Strava push **webhook** + **backfill on connect**. No polling as the primary mechanism (a periodic reconcile-pull is a deferred safety-net).
- **Personal-only (§5.4) unchanged:** imported activities land in `strava_activities` (member-own RLS) and show ONLY on the member's own Progress.

## What already exists (reused, not rebuilt)
- champ-app `src/lib/strava-oauth.js` — `loadProvider` (reads `service_integrations` config incl. scopes), `buildAuthorizeUrl`, `exchangeCode`.
- champ-app `/api/oauth/strava/{start,callback}` — the connect flow (web + native, HMAC-signed state), upserts `contact_external_integrations` (tokens, `expires_at`, `scopes`, `external_athlete_id`).
- un1t-crm `src/lib/strava.js` — `exchangeCode`, **`refreshAccessToken`** (token refresh), `uploadTcx`/`pollUpload` (export).
- `contact_external_integrations` — the token store: `external_athlete_id` (the Strava athlete id = webhook `owner_id` match key), `access_token`, `refresh_token`, `expires_at`, `scopes`, `auto_export_enabled`, `disconnected_at`.
- `strava_activities` (mig 308) — the personal-only store + the champ-app Progress display card.

## Components

### 1. Scope: add `activity:read_all`
Add `activity:read_all` to the Strava provider's `scopes` in `service_integrations` (and the `strava-oauth.js` fallback default). `read_all` so a member's **own private** activities import too (their own data, shown only to themselves; Strava's consent screen notes "including private"). Existing connections (just Richard today) must **reconnect once** to grant the new scope — Strava scopes are per-grant. New connects get read+write together.

### 2. Strava API client additions — un1t-crm `src/lib/strava.js`
- `getActivity({ accessToken, activityId })` → `GET /api/v3/activities/{id}` (detailed activity — has `calories`).
- `listActivities({ accessToken, afterEpoch, perPage })` → `GET /api/v3/athlete/activities` (summary activities for backfill).
- `ensureFreshToken(db, connectionRow)` — refresh-if-expired-and-persist: if `expires_at` is past (or within a margin), call `refreshAccessToken`, write the rotated `access_token`/`refresh_token`/`expires_at` back to `contact_external_integrations`, return the live access token. Extract/reuse the equivalent the export worker (`external-export.js`/`run-strava-exports`) already does so there's one refresh path.

### 3. Direct-Strava mapper — un1t-crm `src/lib/strava-direct-map.js` (pure)
`mapStravaApiActivity({ contactId, activity, athleteId })` → `strava_activities` row:
- `strava_activity_id` = `String(activity.id)` (Strava's real activity id — the canonical dedup key for the direct path)
- `activity_type` = `activity.sport_type || activity.type`, `name` = `activity.name`
- `started_at` = `activity.start_date`, `duration_seconds` = `activity.moving_time ?? activity.elapsed_time`
- `distance_meters` = `activity.distance`, `calories_kcal` = `activity.calories ?? null` (detail-only; null on summary)
- `avg_hr_bpm` = `activity.average_heartrate ?? null`, `max_hr_bpm` = `activity.max_heartrate ?? null`
- `raw_metadata` = `{ source: 'strava', strava_athlete_id: athleteId, type: activity.type, sport_type: activity.sport_type }`
Defensive numeric/string coercion (mirror the old `strava-activity-map.js`).

### 4. Webhook receiver — un1t-crm `/api/webhooks/strava/route.js` (public route)
- **GET** (subscription handshake): if `hub.mode==='subscribe'` and `hub.verify_token === process.env.STRAVA_WEBHOOK_VERIFY_TOKEN`, respond `200 { 'hub.challenge': <hub.challenge> }`; else 403.
- **POST** (event): body `{ object_type, object_id, aspect_type, owner_id, updates }`. Act only on `object_type === 'activity'`.
  - Resolve member: `contact_external_integrations` where `external_athlete_id = String(owner_id)`, `provider='strava'`, `disconnected_at IS NULL`. **Unknown athlete → 200 skip** (we get events for every athlete who authorised the app; ignore ones we don't track).
  - `create`/`update`: `ensureFreshToken` → `getActivity(object_id)` → `mapStravaApiActivity` → upsert `strava_activities` (onConflict `contact_id,strava_activity_id`).
  - `delete`: delete `strava_activities` where `contact_id` + `strava_activity_id = String(object_id)`.
  - Always return **200** quickly (Strava disables subscriptions that error/timeout); do the fetch+upsert within the request (volume is low) or log+skip on fetch failure.
  - **Security model:** Strava does **not** sign webhook POSTs. The events carry only ids (no sensitive data); we act only on `owner_id`s we have a token for, and fetch detail with **our own** member token. This is Strava's standard webhook security posture. The endpoint is public (added to middleware/AppShell public paths like other `/api/webhooks/*`).

### 5. Backfill on connect — un1t-crm `/api/cron/strava-import/route.js` (CRON_SECRET-gated) + mig
- Migration: add `import_backfilled_at timestamptz` to `contact_external_integrations`.
- Cron (every few min, in `vercel.json` + heartbeat): find strava connections with the read scope, `disconnected_at IS NULL`, `import_backfilled_at IS NULL`; for each → `ensureFreshToken` → `listActivities({ afterEpoch: now-30d })` → map → upsert `strava_activities`; stamp `import_backfilled_at`. Idempotent (upsert + the stamp prevents re-backfill). So history appears within a few minutes of connecting, without a champ-app→un1t-crm cross-call.
- (Deferred safety-net: the same cron could later also reconcile the last ~24h for all connections to catch any missed webhook. Not built v1.)

### 6. champ-app UI consolidation
- **Retire the OW import path** built in #35: delete `/api/wearables/strava/connect` (the OW connect), the web `StravaImportCard` + its "Import your activities" section, and the native `connect-strava.jsx` screen + its integrations card.
- The **unified connect is the existing export provider flow** (`/api/oauth/strava/*` via the `IntegrationsManager` provider list) — once Strava is enabled in `service_integrations` with read+write scopes, one "Connect Strava" grants both directions. Copy tweak: the provider blurb explains it both imports activities and (optionally) exports sessions.
- **Keep** the Progress "Strava activities" card (reads `strava_activities`) — unchanged.

### 7. Decommission OW Strava — un1t-crm
- IB5 (`/api/webhooks/openwearables`): the `strava` branch becomes an explicit **ignore** (`connectionProvider === 'strava'` → return `200 { skipped: 'strava_handled_directly' }`) so a stray OW Strava event can never fall through to the session/pull path. (mig 309's `'strava'` in the `hr_provider_connections` CHECK becomes vestigial — leave it; harmless.)
- Delete the OW-created `hr_provider_connections` row (`provider='strava'`, the one inserted during the OW spike) and the 2 OW-uuid `strava_activities` rows (the backfill re-creates them keyed by real Strava ids).
- Optional cleanup: disconnect Strava in OW (`DELETE /api/v1/users/{owUserId}/connections/strava`) so OW stops polling it. Not required (we ignore its events).

## Data flow
- **Connect:** member taps Connect Strava → grants read+write → token row upserted → backfill cron pulls last 30d → activities on Progress within minutes.
- **New activity:** Strava → our webhook (seconds) → fetch detail + upsert → on Progress.
- **Export:** unchanged — UN1T strap sessions → Strava via `activity:write`.

## Env / operator one-time
- New env (un1t-crm): `STRAVA_WEBHOOK_VERIFY_TOKEN` (random string; used in the handshake + when registering the subscription).
- Operator/agent one-time: (a) enable `strava` in `service_integrations` with `scopes` incl. `activity:read_all` + `activity:write`; (b) register the Strava push subscription once (`POST https://www.strava.com/api/v3/push_subscriptions` with `client_id`, `client_secret`, `callback_url=https://crm.un1tdublin.com/api/webhooks/strava`, `verify_token`) — agent can run this after the receiver deploys; (c) reconnect Strava once (Richard) to grant the read scope.

## Testing
- **Pure:** `mapStravaApiActivity` (summary + detailed shapes; missing calories/HR → null; bad numerics → null).
- **Webhook route:** GET handshake (token match/mismatch), POST create/update (owner→contact match → upsert), delete (row removed), unknown athlete (skip, no upsert), non-activity object_type (ignored). Mock the strava client + db.
- **Backfill cron:** picks only read-scoped un-backfilled connections, upserts, stamps `import_backfilled_at`; CRON_SECRET gate.
- **Live E2E:** reconnect Strava (read granted) → backfill shows history → log a new Strava activity → webhook delivers → appears on Progress. Confirm 0 `heart_rate_sessions` with strava data (personal-only holds).

## Out of scope
- Apple (stays on OW for now — separate effort).
- Periodic reconcile-pull safety-net (deferred; webhook + connect-backfill cover v1).
- Any Strava data in points/leaderboards/feed/community (forbidden by §5.4 — `strava_activities` is structurally personal-only).
