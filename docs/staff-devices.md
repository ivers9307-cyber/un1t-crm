# Staff device visibility (STAFF-DEV)

> Built 2026-07-31 on `feat/staff-devices` (migration 466). Answers three operator questions that previously had no answer at all: *what version is each staff member actually running*, *what devices do they have*, and *has the phone granted the background location that geofence attendance needs*.

**Why it exists.** Geofence attendance (mig 463, `docs/staff-attendance.md`) only fires if the staff member's phone is on a recent build AND has granted **Always** location. When it silently doesn't fire there was no way to tell which of those two was missing — the CRM knew neither. STAFF-DEV makes both visible, and adds a throttled push to chase the stragglers.

---

## The verdict rules (one lib, three surfaces)

Every verdict comes from **`src/lib/staff-devices.js`**. It is a pure module: no IO, no Supabase, and deliberately **no `Date.now()`** — the clock is injected as a `now` argument so a page render, an API response and a test all judge against one comparable instant. Callers pass `Date.now()` at the call site.

| Term | Definition | Why |
|---|---|---|
| **Current device** | The row with the greatest `last_seen_at`. | **Newest device wins, not best version.** An old iPad left on a newer build must not mask the daily phone that never updated. Every verdict — version, permission, throttle — keys off this one row. |
| **Stale device** | Not seen in `STALE_AFTER_DAYS` (30). | Rendered dimmed with a `Stale` chip, and **never allowed to set the target version** — an abandoned beta install would otherwise put the whole fleet permanently "behind". |
| **Target version** | Highest parseable `app_version` among **non-stale devices of ACTIVE staff**. | No operator setting to maintain: it self-updates the moment a new build lands on somebody's phone. Leavers are excluded so an ex-staffer's newer phone can't mark everyone still here as outdated. |
| **Verdict kind** | `no_device` \| `unknown_version` \| `outdated` \| `current` | `outdated` requires a target to compare against — with no target, nobody is behind. |

`parseVersion` tolerates the junk that is actually in the column (leading `v`, missing minor/patch, `-beta`/`+build` suffixes) and compares **numerically**, so `2.10.0 > 2.9.0`. It rejects any segment above 9999: `app_version` is client-reported and the highest value in the fleet becomes the bar everyone else is measured against, so one device claiming `9999999999` would otherwise mark the whole estate outdated (the mobile register endpoint validates the same shape).

## Null permission ≠ denied

`device_tokens.geofence_permission` (mig 466) is **NULL until a device reports one**. A NULL renders as `—`, never as `Denied`:

- clients below 2.2.0 (and any build before the STAFF-DEV JS) never report at all;
- **absence of data is not a denial**, and conflating them destroys the entire diagnostic — "we don't know" and "they said no" need completely different follow-ups.

The reported value is background-first, because the column answers *"can geofence attendance fire on this phone?"*:

| Value | Meaning |
|---|---|
| `always` | Background location granted — geofencing works. |
| `denied` | Background denied. On iOS this **includes "While Using"**, whose background status expo reports as denied — correct for this column's question. |
| `when_in_use` | Background still undetermined while foreground is granted. Mainly an Android shape. |
| `undetermined` | Never asked. |

### How it gets there

`mobile/components/LocationGate.jsx`'s `check` runs on mount and on every foreground. It maps the two OS reads to one value and calls `reportDeviceState()` (`mobile/lib/push-register.js`) **only when the value changed** since the last report (held in a ref), never while impersonating and never without a session — mirroring the gate's own early-outs. It is fire-and-forget inside its own `try/catch`: reporting must never block or break the gate. The last-reported ref only advances on a report that actually landed, so an offline attempt retries on the next foreground.

`reportDeviceState()` exists because `registerForPushNotifications()` early-returns on a simulator, a studio kiosk, or a **declined notification prompt** — so a staffer who said no to notifications never reported an `app_version` at all and looked like they had no app. It refreshes the same row without prompting for anything, keeping the studio-kiosk carve-out.

> ⚠️ **The upsert trap.** `device_tokens`' conflict target is `expo_push_token`, so an upsert rewrites the whole row and **an omitted key overwrites the stored value with NULL** — that is exactly why `device_name`/`app_version` go blank for old clients. `geofence_permission` / `geofence_permission_at` are therefore spread into the patch **only when the client actually sent a value**. Any future column on this table must do the same, or every register from an older build will wipe it.

## Surfaces

| Surface | Question it answers |
|---|---|
| `/settings/notifications/health` | **The fleet.** Per-location table: push-token status, device count, app version + `Outdated` chip, location permission, last seen, pushes in 30d. Plus an "On latest" rollup tile carrying the target version, and the **Nudge to update** button. |
| `/settings/staff` list | **At a glance.** A Device column (`2.1.0 · 2d`, an amber `Outdated` chip, or a neutral `No app`) and a `Needs update` filter covering `outdated` + `no_device`. |
| Staff profile → Devices card | **One person, in detail.** Every device with platform, version, relative last-seen and permission chip; stale rows dimmed; the current device marked. It fetches the whole fleet payload and renders one entry — acceptable at ~22 staff, and cheaper than a second endpoint that could disagree. |

All three read **`GET /api/staff-devices`** (or the same lib against the same rows), so they can never disagree about who is behind. That endpoint is a service-role read — **RLS does nothing for it** — and `hasPermission(user, 'settings')` is the only thing keeping the fleet (names, emails, devices) away from ordinary staff.

## The nudge, and its 24h throttle

`POST /api/staff-devices/nudge` — body `{ profile_ids[], message? }`, response `{ sent, skipped_throttled, skipped_no_token }`.

1. **The client sends ids, never verdicts.** Who is outdated is recomputed server-side from `device_tokens` and intersected with the request. The UI's recipient list is a preview; it cannot talk the server into pushing at someone who is up to date, and unknown/inactive ids are ignored rather than trusted.
2. **`no_device` profiles are skipped** — they have no token by definition, so a push has nowhere to land. `current` and `unknown_version` are never nudged: we only tell someone to update when we can see they are behind.
3. **One nudge per device per 24h**, held on `device_tokens.last_update_nudge_at` of the current device. Server-side, because a client-side guard is a suggestion and the operator may have several tabs open. It is stamped **only when a push actually landed**, so an Expo outage can't lock the operator out for a day.
4. **A push failure is reported in the counts, never as a 500.**

**The payload carries no `category` — on purpose.** `sendPush` gates a categorised push on `notify_<category>`, and `resolvePermission`'s final tier is `defaults[role][key] === true`, so an **unregistered** key resolves to `false`, not "no opinion". A `category: 'app_update'` would have skipped every staffer holding a location assignment and the nudge would have reached nobody. Categoryless leaves the master `push_notifications` switch and the device permission as the gates — right for an operational notice rather than a preference. Android routing rides `data.type` instead (`TYPE_CHANNELS.app_update` → the existing Updates channel).

## Why old devices vanish: the 90-day sweep

`src/app/api/cron/sweep-stale-push-tokens/route.js` **deletes** `device_tokens` rows whose `last_seen_at` is older than 90 days (daily, 04:00 UTC). So:

- `no_device` already means **"nothing in 90 days"** — this feature deliberately adds **no competing 90-day rule**;
- a staff member who stops using the app drifts `current → stale (30d) → deleted (90d) → no_device`;
- and a device row reappearing is a genuine re-registration, not a resurrection.

`STALE_AFTER_DAYS = 30` (this lib) and the sweep's 90 are different things: 30 days is "don't trust this to set the bar", 90 days is "this row is gone".

## Files

| Path | Role |
|---|---|
| `supabase/migrations/466_device_tokens_permission_and_nudge.sql` | `geofence_permission`, `geofence_permission_at`, `last_update_nudge_at` + the permission CHECK |
| `src/lib/staff-devices.js` (+ `.test.js`) | Every verdict, pure, injected clock |
| `src/app/api/staff-devices/route.js` | Fleet payload for all three surfaces |
| `src/app/api/staff-devices/nudge/route.js` | The throttled update push |
| `src/app/settings/notifications/health/page.js` | Fleet surface + nudge button |
| `src/components/settings/StaffDevicesCard.jsx` | Per-staff card |
| `src/components/settings/NudgeUpdateButton.jsx` | Confirm modal + counts |
| `mobile/lib/push-register.js` | `reportDeviceState()` |
| `mobile/components/LocationGate.jsx` | Maps the OS reads and fires the report on change |
