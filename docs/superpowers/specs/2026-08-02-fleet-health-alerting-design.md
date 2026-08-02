# Fleet health alerting — design

**Date:** 2026-08-02
**Status:** Spec, awaiting approval
**Ticket:** FLEET-ALERT.1

## Problem

The Stillorgan heart-rate bridge died on **2026-07-16** and nobody noticed for **17 days**. Across that window the system created **1,186 heart-rate sessions containing zero samples** — members finished classes and the data behind their post-class reports was empty.

Two things had to fail together for that to last seventeen days.

The first is fixed. `/admin/bridges` rendered `ble_bridges.status` raw, and that column only ever moves toward `'online'` — a Pi that loses power cannot send a final `'offline'`. So the page showed a green **ONLINE** chip with *"Last seen 15 days ago"* printed beside it. `BRIDGE-STATUS.1` (#1193, merged) now derives the badge from heartbeat freshness.

The second is not fixed, and is the reason this spec exists: **nothing shouts.** Correcting the badge only helps someone who goes and looks at that page. Nobody did, for seventeen days, and nobody will next time either.

There is also a blind spot the badge fix does not touch. The two kiosk Pis driving the wall TVs **report nothing to the CRM at all** — they have no equivalent of the bridge's heartbeat. A TV that goes black is invisible to every surface the business has.

## Goals

1. When a Pi goes dark, a human is told, without anyone having to look at anything.
2. Cover **all** fleet devices — including the kiosks, which are currently invisible.
3. Detect the failure this spec was written for: a device that is *reachable* but whose service is dead. "On the network" is not "working".
4. Tell someone when it recovers, so a resolved alert closes itself.
5. Add no code to any Pi.

## Non-goals

- **Remote control.** Issuing commands to devices is a materially larger security surface (a leaked service-role key would become root on six machines in a semi-public building) and is deliberately excluded. Reviewed and deferred 2026-08-02.
- **A device inventory table.** `fleet.yaml` in `un1t-pi` stays the ops record. This feature derives the device list from Tailscale at runtime; a device that has *never* joined is a provisioning task, not an outage, and `pi list` already covers it.
- **A device management page.** Alerting is the need. A page is a thing someone must remember to visit — the exact failure mode being fixed.
- **Replacing `pi status`.** The CLI stays the deep-diagnosis tool.

## Two independent signals

The July outage would have been caught by either signal. A different failure — the one hit on 2026-08-02, where a Pi joined the tailnet, looked healthy, and ran no bridge — is caught **only** by the second. Both are needed.

### Signal 1 — is the device reachable? (Tailscale API)

`GET /api/v2/tailnet/{tailnet}/devices`, filtered to `tag:un1t-pi`.

Each device carries **`connectedToControl`**, a boolean for whether it is currently talking to the control server. `lastSeen` is present **only when `connectedToControl` is false** — so absence of `lastSeen` is itself the healthy signal, and the code must not treat a missing `lastSeen` as "never seen".

This covers every Pi with zero device-side code, kiosks included, because they are already tailnet members.

### Signal 2 — is the service actually working? (Supabase)

Reachability is not health. On 2026-08-02 a freshly provisioned Pi 5 sat on the tailnet, answered SSH, and reported `cloud-init status: done` — while `champ-bridge` had never installed and no data flowed. Signal 1 would have called that healthy.

For bridges, reuse **`deriveBridgeStatus()`** from `src/lib/bridge-samples.js` — shipped in `BRIDGE-STATUS.1`, already tested, and already what the TV connection dot and the admin badge use. Reusing it means the alert, the badge and the TV dot cannot disagree with each other, which is a property worth more than the few lines it saves.

Kiosks have no equivalent signal today. That is an accepted gap: Signal 1 catches a dead kiosk Pi, and a Pi that is up with a dead browser is a real but rarer failure. Closing it would require device-side reporting, which this spec excludes. Noted rather than solved.

## Decision logic

A pure module, `src/lib/fleet-health.js`, with an injected clock — matching `decideConnectionHealth()` and `src/lib/staff-devices.js`.

```
gradeDevice(device, bridgeRow, nowMs) -> {
  name, role, state: 'ok' | 'unreachable' | 'service_down', detail, since
}
```

- `connectedToControl === false` and offline longer than `OFFLINE_AFTER_MS` → **unreachable**
- reachable, is a bridge, `deriveBridgeStatus()` is not `'online'` → **service_down**
- otherwise → **ok**

`OFFLINE_AFTER_MS = 15 minutes`.

**The threshold is load-bearing, and the reason is the fleet's own behaviour.** Every Pi reboots at 04:00 by fleet standard, and provisioning ends with a `power_state: reboot`. A naive threshold would page every device, every night, and an alert that cries wolf nightly is worse than no alert — it trains everyone to ignore it. A reboot takes roughly 90 seconds; 15 minutes clears it with an order of magnitude to spare while still catching a real outage within a quarter of an hour. Seventeen days was the alternative.

## Alert state

Alerting needs memory, or the cron pages every five minutes forever.

One small table (new migration):

```sql
create table fleet_device_health (
  device_name   text primary key,      -- Tailscale hostname, = fleet.yaml name
  state         text not null,         -- ok | unreachable | service_down
  state_since   timestamptz not null,
  alerted_at    timestamptz,           -- null = not yet alerted for this episode
  last_checked  timestamptz not null
);
```

This is alert bookkeeping, not an inventory: rows appear when Tailscale first reports a tagged device and carry no configuration. `fleet.yaml` remains the record of what *should* exist.

Transitions:
- `ok` → not-ok: write the new state, alert, stamp `alerted_at`
- not-ok → not-ok: no alert (already told)
- not-ok → `ok`: alert recovery, clear `alerted_at`

## Delivery

**Push**, sent **categoryless**, and this is deliberate. The estate has been bitten twice (`STAFF-DEV.8`, `PUSH-TEST.1`) by the same trap: `sendPush` gates on `notify_<category>`, and `resolvePermission`'s last tier is `defaults[role][key] === true`, so an **unregistered category resolves false** — the push reaches the master who tested it and silently nobody else. Fleet health is an operational notice, not a per-person preference, so it takes the categoryless path where the master switch and OS permission remain the only gates.

**Email** to master users as the durable record, since a push is easy to miss and this is exactly the kind of thing to find in the morning.

Recipients: masters. A per-location permission key can come later if staff want it; starting narrow avoids inventing a preference nobody asked for.

## Cron

New route `/api/cron/fleet-health`, `*/5 * * * *`, Bearer `CRON_SECRET`.

Per repo invariant it **must** call `stampHeartbeat('fleet-health')` on a clean run, with the `cron_heartbeats` row created in the same migration — otherwise the monitor silently goes stale, which would be a particularly poor joke for a monitoring feature.

## Auth

Tailscale **OAuth client** (client credentials → `https://api.tailscale.com/api/v2/oauth/token`, one-hour token) rather than a static API key, so the credential is rotatable and scoped.

New env, dormant until set — same pattern as the Homey integration:

```
TAILSCALE_OAUTH_CLIENT_ID
TAILSCALE_OAUTH_CLIENT_SECRET
TAILSCALE_TAILNET          # tail23a156.ts.net
```

**Verify at build time:** whether a read-only `devices:read` scope exists. Tailscale's docs list `devices:core` (read *and* write) and note the full scope list moved to the trust-credentials topic; `dns:read` exists, so a read-only device scope probably does. If it does not, this client can authorise device deletion — worth knowing before minting it.

If the env is unset the cron no-ops cleanly and still heartbeats, so the feature ships dark and is enabled by configuration.

## Testing

Pure functions carry the logic and take an injected clock, so every case is a unit test with no DB and no clock skew:

- device offline 5 min → `ok` (the 04:00 reboot case — the most important test here)
- device offline 20 min → `unreachable`
- reachable bridge with stale `last_seen_at` → `service_down` (the 2026-08-02 case)
- `lastSeen` absent while `connectedToControl` is true → `ok`, not "never seen"
- already-alerted device stays not-ok → no second alert
- not-ok → ok → recovery alert, `alerted_at` cleared

## Rollout

1. Migration (table + `cron_heartbeats` row), applied before the code deploys.
2. Ship with env unset — dark, no alerts.
3. Mint the OAuth client, set env, watch one 04:00 reboot cycle produce **no** alerts.
4. Power off a kiosk deliberately; confirm an alert inside 15 minutes and a recovery alert on power-up.

Step 3 is the one that matters. If the nightly reboot pages everyone, the feature gets muted within a week and the seventeen-day failure becomes possible again.

## What this does not fix

A kiosk Pi that is powered and on the tailnet but showing a black screen — compositor dead, browser not running — reads as `ok`. That failure happened on 2026-08-02 (lightdm crash-looped five times and systemd gave up). Catching it needs device-side reporting, which is out of scope here. It is the strongest argument for a future kiosk heartbeat, and the honest limit of a zero-device-code design.
