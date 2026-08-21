# Sonos Control Integration — Design

**Date:** 2026-08-20
**Status:** Approved in conversation (Richard, 2026-08-20)
**Repo:** un1t-crm
**Supersedes:** the Homey direct-control path (`docs/superpowers/specs/2026-08-01-homey-direct-control-design.md`). The Homey Pro is being decommissioned; this spec replaces its only remaining live job (studio music) and deletes the rest.

## Why

The Homey Pro is being retired. On paper it held 50 adopted Tapo devices; in practice it was idle — **0 of 50 had a schedule**, **46 of 50 had been unreachable since 2026-08-10**, and the reconcile cron was writing no device state at all by 2026-08-20 14:26 while still stamping a green heartbeat. Its one real job was scheduled music on the studio Sonos, run from Homey Flows: **start a favourite at a time, set a volume, stop at a time.** Nothing class-linked.

Sonos's built-in alarms would cover that natively and on-device. Richard's call is to build the integration instead, so studio music lives in the CRM alongside the rest of the automation estate and class-linked music later is a UI change rather than a new integration.

`class_climate` (Sensibo) and `bathroom_climate` (LG ThinQ) are on entirely separate paths and are untouched by any of this.

## Architecture

```
un1t-crm (Vercel) ──HTTPS──▶ api.ws.sonos.com/control/api/v1 ──▶ Sonos household (studio)
  │ /api/cron/sonos-reconcile  (* * * * *)      Bearer, 24h access token
  │ /api/sonos/connect + /callback              one-time OAuth → sonos_connections
  └ src/lib/schedule/desired-state.js           moved from src/lib/tapo/, behaviour unchanged
```

Three modules, mirroring the Homey split that worked:

- **`src/lib/sonos/client.js`** — config, token exchange/refresh, never-throw HTTP.
- **`src/lib/sonos/groups.js`** — pure mappers + `planActions`.
- **`src/lib/sonos/reconcile.js`** — orchestration.

### Group IDs are ephemeral; player IDs are not

Sonos documents group and session IDs as **ephemeral** and player IDs as **permanent and immutable** (MAC-derived). A schedule keyed on a group ID breaks the first time anyone regroups a speaker in the Sonos app.

Therefore: **schedules target player IDs**, and every tick resolves the current group from a fresh `GET /households/{id}/groups`. That one call returns groups *and* players *and* each group's `playbackState`, so the read side costs exactly one request per tick.

Group resolution rule: find the group whose `playerIds` contains the schedule's **first** player id, and act on that group. If the schedule's players span more than one group, act on each distinct group once — never once per player, or a four-speaker schedule sends four `loadFavorite` calls to the same group.

### One location = one household

`sonos_connections.location_id` is `UNIQUE`, which stops one location from acquiring two connection rows. `household_id` is `UNIQUE` too — stored explicitly at link time from the operator's selection, **never `households[0]`** — and that second constraint is the one that actually mirrors the Xero `tenants[0]` bug: three locations resolved to one org and put 101 bills (~€99k) in the wrong entity. Cheap to prevent on day one.

## The command model — exactly once per window

This is the one place the Sonos integration must **not** copy the Homey design.

The Homey reconcile was a continuous desired-vs-actual loop, which is safe because flipping a plug that is already on is a no-op. `loadFavorite` is not idempotent: re-issuing it every minute restarts the playlist from the top, forever.

So the model inverts. Each tick resolves the active window and asks **"have I already applied this window?"** — not "does actual match desired?". State lives in `sonos_schedules.last_applied = {window_on_at, action, at}`.

| Transition | Calls, in order |
|---|---|
| Window opens | `POST /groups/{id}/groupVolume` `{volume}` **then** `POST /groups/{id}/favorites` `{favoriteId, playOnCompletion: true}` |
| Window closes | `POST /groups/{id}/playback/pause` |

### The state machine

Each window is identified by its resolved `on_at` instant. Per tick, for the schedule's serve set:

1. **Inside window W, and `last_applied` is not `{W, open}` or `{W, close}`** → apply open, write `{W, 'open'}`.
2. **Past W's `off_at`, and `last_applied` is `{W, 'open'}`** → apply close, write `{W, 'close'}`.
3. **Anything else** → no-op.

Rule 2 is deliberately conditional on having opened W. If the CRM was down for a whole window and comes back after it ended, there is no record of opening it, so no pause fires — otherwise a recovery would silence music a coach had started by hand. A window that opened and closed cleanly leaves `{W, 'close'}`, which both rules reject on subsequent ticks.

Volume is set **before** the favourite loads, or the first seconds of playback come out at the previous window's level.

Three properties this buys:

- **Missed ticks self-heal.** If the cron misses 06:00, the 06:01 tick still sees the window unapplied and fires. Edge-detection on playback state would not.
- **Humans win mid-window.** A coach who pauses the music, or turns the volume down at the speaker, stays that way until the next boundary. The CRM acts at boundaries only and never fights the room. This is the same principle as the Homey override chip, applied by default.
- **Restart-safe.** A redeploy mid-window re-reads `last_applied` and does nothing.

`playbackState` from the groups response is recorded into `last_state` for the UI. It is **not** a control signal.

### Error handling

- `499 / ERROR_PLAYBACK_NO_CONTENT` when pausing an idle group is **benign** — swallow it and still mark the window applied. Otherwise every close-window tick retries forever.
- `404` means the group changed between the read and the write. Log and let the next tick re-resolve; do not retry in-tick.
- `429` carries `Retry-After`. At this shape it should never fire (see below) — if it does, it is a bug, so log it loudly rather than backing off silently.
- A failed Sonos `GET` writes nothing and returns success to the cron; `last_state` staleness is the alert, matching the Homey convention.

### Rate limits

Quota is 1,000 requests/minute; spike arrest at 100 requests/second. This design issues one `GET groups` per tick plus a few commands at boundaries — roughly 1,500 requests/day. Sonos advises an event-subscription model over polling for high-volume apps; at this volume polling is well inside the envelope and avoids running a public webhook endpoint. Send a `User-Agent` header — Sonos names its absence as a throttling trigger.

## OAuth

| Item | Value |
|---|---|
| Authorize | `https://api.sonos.com/login/v3/oauth` |
| Token | `https://api.sonos.com/login/v3/oauth/access` |
| Scope | `playback-control-all` (the only scope Sonos offers) |
| Client auth | `Authorization: Basic base64(client_id:client_secret)` |
| Access token | 24 hours |
| Refresh token | **Does not rotate** — the same value is returned on every refresh |
| Redirect URI | HTTPS, publicly routable, exact match against the integration manager |

Because refresh tokens do not rotate, none of `xero_connections`' rotation-race handling is needed — no read-modify-write contention on the token row, no risk of a concurrent refresh invalidating the stored value. Refresh when `access_token_expires_at` is inside a 5-minute margin; persist the new access token and expiry only.

**Linking is one-time and staff-driven.** `/api/sonos/connect` builds the authorize URL with a signed `state`; `/api/sonos/callback` validates `state`, exchanges the code, reads `GET /households`, and stores the chosen household plus the refresh token. Re-linking after a revoke is a button, not a deploy — deliberately unlike the hand-pasted `HOMEY_*` env triple.

**A `household_id` collision needs its own error path in the callback, not a generic save failure.** Postgres `ON CONFLICT (location_id)` does not catch a conflict on the separate `household_id` unique index — a colliding insert hard-fails instead of upserting — so the callback must catch that case explicitly and name the other location, following the pattern in `src/lib/xero/tenant-binding.js`'s `validateTenantChoice`.

Env is only `SONOS_CLIENT_ID` / `SONOS_CLIENT_SECRET` / `SONOS_REDIRECT_URI`, from the Control Integration registered at `integration.sonos.com`. Config is tri-state like the Homey client: all unset = dormant (cron stamps its heartbeat and exits `{skipped:true}`, never pages); partially set = misconfigured, logged loudly every tick; all set = live.

## Data model

```sql
sonos_connections
  id uuid PRIMARY KEY
  location_id uuid NOT NULL UNIQUE REFERENCES locations(id)   -- one household per location
  household_id text NOT NULL UNIQUE                           -- one location per household
  refresh_token text NOT NULL
  access_token text
  access_token_expires_at timestamptz
  linked_by uuid, created_at, updated_at

sonos_schedules
  id uuid PRIMARY KEY
  location_id uuid NOT NULL REFERENCES locations(id)
  name text NOT NULL                  -- 'Studio music'
  player_ids text[] NOT NULL          -- permanent RINCON ids; group resolved per tick
  enabled boolean NOT NULL DEFAULT false
  windows jsonb NOT NULL DEFAULT '[]' -- [{days:[1..7], on:'06:00', off:'21:30', volume:35, favorite_id}]
  override jsonb                      -- {state:'off', until} — suppression only, see below
  last_applied jsonb                  -- {window_on_at, action, at}
  last_state jsonb                    -- {playback_state, group_id, at}
  created_at, updated_at
```

`enabled` defaults to **false** — house convention, matching `location_automations` and the Tapo adopt flow. Nothing plays until an operator turns it on.

Several rows per location are allowed so a second zone (reception vs floor) needs no migration later. v1 creates exactly one.

RLS follows the advisor-consolidation pattern — permissive per-command policies, never `RESTRICTIVE FOR ALL`, which silently kills `SELECT` and realtime.

## Reusing the schedule engine

`src/lib/tapo/desired-state.js` moves to **`src/lib/schedule/desired-state.js`**, tests included, behaviour unchanged. It is 139 lines carrying four traps already paid for: Dublin spring-forward correctness (`dublinWallMs` guess-and-correct rather than flat minute addition), overnight window tails (yesterday's still-live fixed windows unioned with today's), overnight `off` re-resolved on the next calendar day rather than `+24h`, and override-checked-before-mode-none. Rewriting that for Sonos would mean re-earning all four.

Sonos consumes **`resolveServeWindows(schedule, dublinToday)`** — the window set — not `desiredState()`. `desiredState` collapses the day to `'on'|'off'|null` and applies its own override semantics, both of which are wrong here: the planner needs the *identity and payload* of the active window, and override in this feature is suppression rather than a forced state. `desiredState` stays exported and untouched for the engine's own tests and any future consumer.

**One additive edit:** `resolveDayWindows` currently returns `{on_at, off_at}` and drops the originating window. It must carry `source: w` through so the planner can read that window's `volume` and `favorite_id`. Additive only — existing assertions are unaffected.

`schedule_mode: 'class'` stays in the engine, unused by the Sonos UI in v1. Class-linked music later is then a UI change riding `class_occurrences` — the same spine `class_climate` and HR allocation already use — not an engine rewrite.

## Operator surface

`/automations/sonos`, gated on the **existing `device_control` permission**. That key is already wired through the role templates and the nav union in `src/app/(marketing)/layout.js`; repointing it costs nothing and deleting a working permission to mint an identical one costs a migration.

The page offers: connect/re-link the household, pick players from the live list, add schedule windows (days, on, off, volume, favourite from `GET /households/{id}/favorites`), an enable toggle, an override chip, and a "run now" button. `last_state` and `last_applied` render as the health indicator, mirroring the Homey device page's staleness dots.

**Override is suppression only** — `{state:'off', until}`, surfaced as "Leave the music alone until midnight". While live, every tick short-circuits to a no-op: no open, no close, no volume. There is no `{state:'on'}`, because "on" would have to invent a volume and a favourite from somewhere, and the honest source for both is a window. Setting an override does **not** pause anything that is currently playing; it only stops the CRM acting.

**"Run now" re-applies the currently active window** by clearing `last_applied` for it, so the next tick treats it as unapplied and fires rule 1. Outside any window it is a no-op, not a pause — the button exists to recover a window the room overrode, not as a hidden stop control.

## Homey removal

**Delete:**

- `src/app/api/tapo/devices/route.js`, `.../[id]/route.js`, `.../[id]/toggle/route.js`
- `src/lib/homey/` — `client.js`, `devices.js`, `reconcile.js` and their tests
- `src/app/api/cron/homey-reconcile/route.js` and its `vercel.json` entry
- `src/app/(marketing)/automations/devices/page.js`
- `tapo_devices` (migration) and the `homey-reconcile` row in `cron_heartbeats`
- Vercel env `HOMEY_API_URL`, `HOMEY_API_KEY`, `HOMEY_LOCATION_ID`

**Keep:** `desired-state.js` (moved), the `device_control` permission.

**Ship order matters.** The heartbeat row must be dropped only *after* the deploy that removes the cron — the health check 503s on any stale row, so a row whose cron no longer exists reads as an outage. Same trap the `bathroom_climate` mig-447 rollout documented, in reverse.

## Testing

- **Pure, unit-tested:** `planActions` (window→action mapping incl. the already-applied short-circuit, multi-group dedupe, volume-before-favourite ordering), the group resolver, config tri-state, and the engine edit.
- **Client tested against mocked `global.fetch`**, house pattern from `sensibo.js` / `thinq.js` / the Homey client — including the 499-is-benign path and refresh-on-expiry.
- **Reconcile orchestration** tested with injected `getGroups` / `sendCommand` fakes, per `zoom/reconcile.orchestrator.test.js`.
- The API key and client secret must never appear in a log line or thrown error — every error path names the env var, never its value.

## Accepted trades

- **Cloud dependency.** Sonos does not release its LAN API for wide use, so this inherits the same outage exposure as the Homey path: a studio internet or Sonos cloud outage pauses scheduled music until it returns. Stated and accepted (Richard, 2026-08-20). The Sonos app remains the manual fallback, and Sonos alarms remain available as a belt-and-braces backstop if that ever bites.
- **Boundary-only control.** Music paused mid-window stays paused until the next boundary. Deliberate — the alternative fights the room.
- **`last_applied` is per schedule row**, so editing a window mid-window does not retroactively re-apply it. The "run now" button is the escape hatch.

## Out of scope for v1

Class-linked music (engine supports it, UI does not expose it), audio-clip announcements, per-player volume, multi-zone grouping/ungrouping, and event subscriptions. None require schema changes to add.
