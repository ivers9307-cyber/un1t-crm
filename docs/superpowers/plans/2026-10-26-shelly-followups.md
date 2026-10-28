# Shelly follow-ups — icon picker, tidy-ups, safety-net timers, alerts

**Spec:** `docs/superpowers/specs/2026-10-26-shelly-groups-lights-design.md` plus Richard's decisions of 2026-10-26 (below). Three PRs.

## Decisions (Richard, 2026-10-26)
- Build: safety-net timers, alerts, a group icon picker, the small review tidy-ups. Widget group buttons: not now.
- Timers: when a schedule switches a device ON, the device's own `toggle_after` is set so it switches itself OFF **30 minutes after the planned off time** if nothing else did. Manual presses set it too.
- Alerts: **phone push to owners and managers** of the studio, for: **Shelly key stopped working**, **device offline > 15 min**, **power fault** (overpower / overtemp / overvoltage / undervoltage).

## Global constraints
- CLAUDE.md invariants apply (exactly-once stamps only for landed devices; never log URLs/bodies/the key; supabase write errors checked; a new push category is REGISTERED — bare name, `notify_<x>` key in MOBILE_PERMISSIONS + DEFAULT_MOBILE_PERMISSIONS_BY_ROLE + CATEGORY_CHANNELS, else it fails closed; anything under `mobile/` or `shared/` ships as an OTA on merge).
- Shelly: `set/switch`, `set/light` and each `set/groups` command accept `toggle_after` (seconds; the device flips to the opposite of `on` after the delay). 1 request/second per account.
- No migration in any of the three PRs unless a task says so.

---

## PR A — icon picker + review tidy-ups (web + phone; OTA)

### Task A1: Group icon picker (web)
- `ShellyGroupCard.jsx`: an icon button on the card opens a small picker of the five icons (bulb, fan, tv, plug, droplet — the mig 776 CHECK list); choosing one PATCHes `{icon}`; New group gets a default `bulb` (unchanged). Test: picking "fan" PATCHes `{icon:'fan'}` and the card shows it.

### Task A2: Tidy-ups
- Preview caption (`ShellyDayPreview.jsx`): when several class groups have different gaps, word it per group ("Gym lights: classes under 30 min apart stay on; Fans: under 15 min") — test.
- On/off pending wording (web `ShellyGroupCard` + phone `groupToggleOutcome`): word pending members from `pending_members[].code` like back-to-schedule does — offline → "will follow when back online"; permanent/`bad_device`/`unverified` → "Shelly refused <name>" / "couldn't confirm <name>" — tests both sides.
- Phone banner cache (`mobile/lib/api.js countUnadoptedShelly`): pull-to-refresh bypasses the 5-minute cache (a `{ fresh: true }` option) — test.
- Preview: two lane labels can overlap (off + override) — stack them or show one ("Never automatic" wins when the group is off) — test.

---

## PR B — safety-net timers (backend)

### Task B1: client carries `toggle_after`
- `setSwitch(id, ch, on, { toggleAfterSec })`, `setLight(...same)`, `setGroups(groups, on, { toggleAfterSec })` add `toggle_after` (integer seconds ≥ 1) only when given. Bodies unchanged when absent. Tests.

### Task B2: planner/reconcile arm the cap
- `SAFETY_MARGIN_MS = 30 * 60_000`. When the planner opens a WINDOW (`reason: 'window_open'` or run-now 'on' inside a window), the command carries `toggleAfterSec = ceil((window.off_at + SAFETY_MARGIN_MS − now)/1000)`. Stamp `last_applied.cap_at` (ISO) = now + toggleAfterSec.
- **Re-arm:** inside a window whose key is already stamped `on`, if `window.off_at + SAFETY_MARGIN_MS > cap_at + 60s` (the window grew, e.g. a class added or a gap merged), re-send `on` with the new cap and re-stamp (reason `cap_extend`). Never send for a shrinking window (the cron's own close handles it).
- Batching: `setGroups` per (direction, cap) — devices in one window share a cap; group by rounded cap (to the minute) to keep batches few.
- Off commands carry no timer. Engine/plan.js rule changes are pure and unit-tested (Dublin + New York).

### Task B3: manual presses arm the cap
- Device toggle and group toggle, `state:'on'` with an `until`: `toggleAfterSec = ceil((until − now)/1000)` and stamp `cap_at`. **Exception (ruling): unmanaged devices/groups** ("stays as you set it until you change it" — no schedule) get no timer, because the copy promises they hold. `state:'off'` gets no timer (a flip to on at expiry could fight the schedule). Back-to-schedule uses B2's window rule. Tests on both routes.

---

## PR C — alerts (backend + push registration; `shared/` → OTA)

### Task C1: power-fault reading
- `status.js` reads `errors` (array of strings) on `switch:N`/`light:N`; `last_state.errors` stored only when non-empty (switch exact-shape rule otherwise unchanged); `stateChanged` notices a change. Tests.

### Task C2: register the push category
- `shared/permissions.js`: `notify_shelly_alert` (mobileOnly, isNotify, label "… Smart plug alerts", hint "Shelly key rejected, a device offline for 15 minutes, or a power fault"); defaults: owner true, manager true, head_coach false, staff false (plus any other roles in the table: false). `shared/push-channels.js`: `shelly_alert: 'alerts'` (or the existing platform-alerts channel — pick the closest existing one). Run `check:mobile-parity`; `tests/push-category-literals.test.js` must pass.

### Task C3: the alert pass
- New `src/lib/shelly/alerts.js` `runShellyAlerts(db, { locationId, conn, devices, nowMs, tz })`, called at the end of each location's reconcile (after state writes), wrapped so a failure never breaks the reconcile. Uses `sendPushToRolesAtLocationOnce(db, eventKey, locationId, ['owner','manager'], payload)` with `category: 'shelly_alert'`:
  - key rejected: when `conn.status === 'action_needed'`; eventKey `shelly_key:<conn.id>:<conn.last_error_at>`; "Shelly stopped accepting the studio's key — re-paste it on the web Smart plugs page."
  - offline: adopted device with `last_state.online === false` and `last_seen_at` older than 15 min; eventKey `shelly_offline:<device.id>:<last_seen_at>` (one push per outage); "<name> has been offline since HH:MM."
  - power fault: `last_state.errors` non-empty; eventKey `shelly_fault:<device.id>:<sorted errors>:<local day>`; "<name> reported <overpower|overheating|over-voltage|under-voltage> and may have switched off."
- Pushes deep-link to the Smart plugs screen (`data.type`/`url` as other pushes do). Tests with an injected push function: each alert once per key, nothing when healthy, a push failure logged and swallowed.
