# Hatch Street screens: the franchise app during class, marketing the rest of the time (SCREENMODE.1)

Design, 24 Oct 2026. Richard's decisions are marked "Richard"; everything else is the designer's call unless it says "builder".

## Why

UN1T Hatch Street has six TCL Android TVs on the gym floor. Each is fed over HDMI 1 by its own generic Android 13 TV box (RK3528, 4 GB RAM, 64 GB storage) running the franchise's class app. Today the boxes show that app around the clock, so for most of the day six large screens show a class screen with no class on it.

Richard wants the screens to earn their keep: the franchise app on screen while a class is running, and marketing content the rest of the time. The decision of which is which belongs in the CRM, next to the other things that run off the class timetable (class climate control, bathroom climate control), not in n8n and not in a third-party signage product.

## What Richard asked for (Richard)

1. Hatch Street only. Stillorgan is untouched.
2. During a class the TV shows the franchise app. Outside class the TV runs as a marketing screen.
3. The automation lives in the CRM's automation section. Not n8n.
4. The boxes are not locked down by the franchisor; apps may be installed on them.
5. The two Raspberry Pi kiosks planned for Hatch (`hatch-tv1`, `hatch-tv2`, the heart-rate board) stay as they are. The six boxes are a separate thing and do not carry the HR board.

## Goals

- A class never starts with marketing on the wall. The franchise app is in front before the first member walks in and stays there until the class is over.
- Outside class, every screen shows content that staff manage from the CRM they already use, with no second product to log into.
- When the timetable changes in un1t.online, the screens follow with nobody touching a box.
- Staff can see from the CRM that each screen is alive and what it is showing, and can override it for the rest of a session with one press.
- A CRM or internet outage during the day costs marketing, never a class screen.

## Non-goals

- Switching the TV's HDMI input or turning the TVs on and off. The TV stays on HDMI 1; the box decides what is on it. Power scheduling (TCL's own timers, or HDMI-CEC later) is a separate piece of work.
- Showing the heart-rate board on these boxes. That is the Pi kiosks' job (Richard).
- Video playlists. The CRM's TV cast surface today shows one image, one URL or one text template per display. A richer idle loop (video, several slides) is a later extension of that surface, not of this design.
- Anything at Stillorgan, or at CCF Autos.
- Remote shell, reboot, screenshot or log pull on the boxes. See "What the boxes cannot do".

## Anti-goals (a failure even if it works)

- A class with marketing on the wall because the CRM was unreachable, the sync was late, or a class was added that morning.
- A black screen. If the agent cannot decide, it shows the franchise app.
- The franchise app losing its state (a coach's set-up, a login) because the box backgrounded it. The bench test in "Rollout" exists to catch this before anything is installed in the gym.
- A device accepting a command string. The fleet's standing rule (`src/lib/fleet-commands.js`, mig 475) is names only, never shell text, and it holds for these boxes too.
- Aggregate studio numbers on a screen anyone can photograph (the standing TV rule from `docs/TV_IDLE_SCENES_DESIGN_2026-10.md`). This design puts no new content on screen, but a later idle extension must keep it.
- A screen that grades healthy while showing the wrong thing. The box reports what it is showing, not just that it is alive.

## Constraints the builder must respect

**The class spine.** Hatch's timetable is projected into `class_occurrences` by the un1t.online sync every 15 minutes (`src/lib/un1t-online-occurrences.js`, mig 734): `source_platform = 'un1t_online'`, `glofox_event_id = 'un1t:' || <un1t id>`, `cancelled_at` set when un1t.online cancels, never deleted. A missing `ends_at` means a 60-minute class (the convention `planClassClimate` uses). Read it with `location_id` and `cancelled_at IS NULL`, like the climate runner does.

**The automations hub.** One row per studio in `location_automations` (mig 276): `automation_key`, `enabled`, free-form `config`. Definitions live in `src/lib/automations/registry.js` and the hub page renders a card per definition; a config-heavy automation gets its own card component (`ClassClimateCard.jsx` is the model). Writes go through `PUT /api/automations/[key]` (manager roles at the studio, `assertLocationAccess`). The pure planning helpers in `src/lib/class-climate.js` (`slotKey`, `classMatchesFilter`, `resolveConfig`'s shape, the lead-in window test) are the ones to reuse or mirror; they are safe to import in the browser.

**The fleet.** `fleet_devices` (mig 474) is the record of every device, keyed by `device_name`, with `location_id`, a `role` CHECK of `('kiosk', 'bridge')`, and a per-device bearer token stored only as a sha256 hash (`fdv_…`, `src/lib/fleet-device-auth.js`, minted once at `/api/admin/fleet/devices/[name]/token`). Devices call authenticated endpoints with that token; they never read Postgres. Realtime is a doorbell (`fleet:<device>` broadcast, no payload, `src/lib/fleet-doorbell.js`), never a data channel. `fleet_commands` carry an allowlisted action name with a 2-minute expiry and are for interactive actions. The fleet-health cron (`/api/cron/fleet-health`, every 5 min) discovers Pis from Tailscale and grades them on reachability; these boxes are not on the tailnet, so that path must neither grade them unreachable nor auto-register them. Permission keys are `fleet_restart` (safe actions, on by default for anyone on shift) and `fleet_admin` (actions that can strand a device). Claiming a device (`PATCH /api/admin/fleet/devices/[name]`) and minting its token are **master-only** today, by explicit design in those routes; there is no route that creates a device row, because Pis arrive through Tailscale discovery.

**The membership-source gate.** The automations hub renders every curated card inside `<MembershipSourceGate capability="schedule">`, and un1t.online declares `schedule: false` (`src/lib/membership/sources/un1t-online.js`, deliberately: "bookings and schedule stay false", pinned by its test and by the capability-reader classifications). So at Hatch, the one studio with screens, the existing cards are hidden behind "un1t.online does not provide a class schedule". The screens card must not inherit that gate (see §3).

**Invocation budget.** Richard's 2026-08-02 call in `un1t-pi/agent/agent.js` dropped the Pi agent from a 60 s poll to hourly because three devices at one request a minute was a real slice of the monthly allowance. Six boxes must be designed to the same standard (see §4).

**The TV cast surface.** `tv_displays` (mig 160) is one row per screen with a bearer `token`; `/tv/cast/<token>` polls `/api/public/tv/[token]/content` every 6 s (`POLL_MS` in `TVDisplay.jsx`; rate limit 240/min per token and IP; the page reads no query parameters today) and renders the pushed `tv_content` row: an image from the `tv-content` bucket, a URL, a text template over a base image (mig 190), or nothing (idle: branding and a clock). Rotation is per display (mig 189). Admin is `/admin/tv-displays` through `/api/admin/tv-displays*` (`src/lib/tv-admin.js`; the `tv_displays` permission, web or mobile).

**House rules.** Service-role routes get no RLS, so the route is the gate (404 not 403 for unknown ids). A new table or column follows mig 677's closed default. A new column holding a secret must be named so `private.audit_is_secret_key()` matches it. Wall-clock config (excluded slots) is in the studio's zone through `@/lib/location-time` / `shared/zoned-time`, never a `Europe/Dublin` literal. Customer-facing copy is operator-editable. A new cron needs a `cron_heartbeats` row; this design adds none.

## The design

### 1. One box, two things on it; the CRM decides which is in front

Each TV box runs two things: the franchise app (already installed) and a small agent app we write, **UN1T Screen**. The agent is the box's home launcher. Its own window is a full-screen web view of the CRM's cast page for that screen, so the marketing content is whatever staff push from `/admin/tv-displays`. When the CRM says a class is on, the agent launches the franchise app; when the window ends, the agent brings itself back to the front. The TV never changes input.

The decision is made in the CRM and handed to the box as a **plan**, not as a stream of commands. The box fetches the plan on a timer, caches it, and acts on it locally at each window boundary. This is why an outage costs marketing and not a class: the box already knows this morning's classes.

### 2. The device record

`fleet_devices.role` gains a third value, `'screen'`. Six rows at Hatch, named `hatch-screen1` … `hatch-screen6` (the fleet naming convention; `label` carries where it hangs, "Rig wall left"). New columns on `fleet_devices`, all nullable and only ever set for screens:

| Column | Meaning |
|---|---|
| `tv_display_id uuid references tv_displays(id) on delete set null` | the cast display this box renders when idle |
| `last_heartbeat_at timestamptz` | last plan fetch, stamped by the plan endpoint |
| `reported_mode text check in ('class_app','marketing','unknown')` | what the box said it was showing on its last fetch |
| `reported_version text` | the agent's version, for the fleet page |
| `override_mode text check in ('class_app','marketing')` | a staff override in force |
| `override_until timestamptz` | when it lapses |

All six boxes point at **one shared** `tv_displays` row, "Hatch screens" (designer's call): staff push one image and all six change. Splitting a screen onto its own display is a per-row change later, nothing structural.

`actionAppliesToRole` returns false for every existing `fleet_commands` action on a screen (none of them make sense on an Android box; see "What the boxes cannot do"), so the fleet page offers none of them and the device endpoint would refuse one if it arrived.

### 3. The automation: `screen_mode`

A fourth entry in `src/lib/automations/registry.js`:

```
key: 'screen_mode'
label: 'Class screens'
description: 'Show the class app on the floor screens during each class and marketing content the rest of the time.'
```

Config on the studio's `location_automations` row (`resolveConfig`-style coercion, defaults in brackets):

| Key | Meaning |
|---|---|
| `device_names: string[]` ([]) | the screen-role fleet devices this applies to; validated against `fleet_devices` at this studio, the way `device_ids` is checked against `ac_devices` (W0.12) |
| `class_app_package: string` | the franchise app's Android package name, e.g. `com.example.classapp`; validated as `^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$`, max 200 |
| `lead_in_min` (10) | franchise app in front this many minutes before `starts_at` |
| `lead_out_min` (5) | back to marketing this many minutes after `ends_at` |
| `class_filter: string[]` ([]) | as class climate: only classes whose name contains one of these; empty is all |
| `excluded_slots: string[]` ([]) | as class climate: recurring "Thu 06:00" slots in the studio's zone to skip |
| `stale_plan_mode: 'class_app' \| 'marketing'` ('class_app') | what the box shows when it has had no fresh plan for 24 hours (see §5) |

The `automationStatus` for this key is "available" when the studio has a membership source with a timetable (the same `connected` boolean the climate cards use) and at least one screen-role device.

The hub card (`ScreenModeCard.jsx`, modelled on `ClassClimateCard.jsx`): toggle; a checklist of the studio's screens; the package name field; lead-in and lead-out; class filter and excluded slots (lift the slot picker from the climate card); and "Today's plan", which calls `GET /api/automations/screen_mode/schedule?location_id=` (extend the key allowlist in that route to include `screen_mode`) and renders the merged windows so an operator can see when the screens will switch. Only Hatch has screens, so only Hatch's card does anything, but nothing in it is Hatch-specific.

**Where the card renders (designer's call).** `ScreenModeCard` renders **outside** the `<MembershipSourceGate capability="schedule">` block, as its own section of the hub page, and gates itself: it shows when the studio has at least one screen-role device, and says "No class timetable is being synced for this studio" when `class_occurrences` holds no future row for the studio. It does **not** flip un1t.online's `schedule` capability to true. That flag also governs the climate cards and the Shelly class mode, which the un1t.online P1 plan keeps inert at Hatch, and it is pinned by the capability-reader tests; widening it is a separate decision with its own blast radius. The screens automation reads the class spine directly, which un1t.online does fill.

### 4. The plan endpoint

```
GET /api/fleet/screen-plan?mode=<class_app|marketing|unknown>&version=<agent version>
Authorization: Bearer fdv_…
```

Device-authenticated (`verifyFleetDeviceToken`), role must be `screen` (anything else is a 404-shaped refusal with no detail), rate-limited per device name at a ceiling a legitimate box can never reach (the cadence is one call every ten minutes plus doorbell rings, so 30/min is ample; all six share the gym's IP, so the key is the device, not the IP). It:

1. Stamps `last_heartbeat_at = now()`, `reported_mode`, `reported_version` on the device row. One request is both the heartbeat and the plan fetch.
2. Reads the studio's `screen_mode` automation row. If absent or disabled, or the device is not in `device_names`, the plan has no windows and the box shows marketing.
3. Reads `class_occurrences` for the studio from now − 6 h to now + 36 h, `cancelled_at IS NULL`, ordered by `starts_at`.
4. Applies `class_filter` and `excluded_slots` (studio zone via `getLocationZone`; a zone read failure is `degraded: 'zone_unreadable'` rather than a guess). The zone is read whenever the device has a studio, so `timezone` is filled even when no windows are due.
5. Turns each class into a window `[starts_at − lead_in, ends_at + lead_out]` and merges windows that overlap or touch, so back-to-back classes are one continuous stretch of the franchise app.
6. Returns:

```json
{
  "ok": true,
  "server_now": "2026-10-24T09:00:00.000Z",
  "generated_at": "2026-10-24T09:00:00.000Z",
  "timezone": "Europe/Dublin",
  "poll_seconds": 600,
  "class_app_package": "com.example.classapp",
  "cast_url": "https://crm.un1tdublin.com/tv/cast/<token>?kiosk=1",
  "stale_plan_mode": "class_app",
  "override": { "mode": "class_app", "until": "2026-10-24T11:00:00.000Z" } | null,
  "windows": [
    { "from": "2026-10-24T05:50:00.000Z", "until": "2026-10-24T07:55:00.000Z",
      "classes": [{ "id": "un1t:123", "name": "UN1T Strength", "starts_at": "…", "ends_at": "…" }] }
  ]
}
```

`cast_url` is built server-side from the device's `tv_display_id` (the display must be active and at the same studio; otherwise `cast_url` is null and the agent shows its own neutral idle: the studio logo and clock, fetched from `/api/public/branding`, no hard-coded copy). The cast token travels to the box this way so the box holds exactly one secret, its device token. `server_now` lets the agent correct for a wrong clock on a generic box (see §6).

**Degraded plans.** If the automation, the occurrences or the zone cannot be read, the empty `windows` would mean "unknown", not "no class", so the endpoint answers **503** `{ ok: false, error: 'plan_unavailable', degraded }` (the heartbeat is already stamped). The agent keeps its cached plan, retries on the next tick and does not reset its stale clock. A 200 plan with `degraded: 'display_unreadable'` is trustworthy (only `cast_url` is null). A 401 is never "de-provision", because the CRM folds a database error into 401; the agent keeps its cache and retries on 401, and backs off to the next tick on 429. The full table is in `docs/fleet-screens.md` section 9.

The window list is computed on request, not stored, and nothing fires server-side, so `automation_fire_log` is not involved and no cron is added.

**Cadence and the invocation budget (designer's call).** The box polls the plan every **10 minutes** (`poll_seconds: 600`; six boxes is about 26k requests a month) and is **rung** by the doorbell whenever something it should know about changes: a staff override (§5), a push or clear of content on its display (the `/api/admin/tv-displays/[id]/content` routes ring every screen linked to that display), and a save of the `screen_mode` config. Because the plan covers 36 hours, the poll is a backstop, not the mechanism. The cast page gets a `?kiosk=1` flag that slows its content poll from 6 s to **60 s** (six web views at 6 s would be about 2.6 million requests a month, which is the class of cost Richard cut the Pi agent for); content changes still land within seconds because the push rings the doorbell and the agent reloads the web view on a ring. A class added in un1t.online therefore reaches the wall within the 15-minute sync plus up to 10 minutes of poll, about 25 minutes at worst; a class added closer to its start than that is what the override button is for. The builder may also ring the doorbell from the un1t.online sync when it changes a studio's occurrences, which would make the poll almost never the path that delivers a change.

### 5. Overrides

An override is **state on the device row**, not a `fleet_commands` row, because commands die in two minutes and an override must last an hour.

`POST /api/admin/fleet/devices/[name]/screen-override` with `{ mode: 'class_app' | 'marketing', minutes: 30 | 60 | 120 | 240 }` or `{ clear: true }`; session route gated on `fleet_restart` at the device's studio (it is in the safe tier: the worst outcome is the wrong thing on a wall until it lapses), device must be a screen (404 otherwise). It writes `override_mode` and `override_until`, then rings the doorbell so the box fetches the plan at once rather than at its next tick. The plan endpoint returns the override while `override_until > now()`; the agent gives it precedence over windows. The fleet page shows screens in their own section with: last seen, what it is showing, the override in force, and three buttons: **Show class app for 1 h**, **Show marketing for 1 h**, **Back to schedule**.

### 6. The agent app: UN1T Screen

A small native Android app (Kotlin, minSdk 33). It lives in its own repository, `un1t-screen`, the way the Pi code lives in `un1t-pi` (designer's call: the CRM repo's `mobile/` is the Expo app and its OTA allowlist watches that tree; an Android Studio project does not belong under it). What it does:

- **Home launcher.** Declares the `HOME` intent category and is set as the default home activity at provisioning. This is what lets it bring itself to the front from the background on Android 13 without an overlay permission, and what the box comes back to after a reboot or if the franchise app crashes.
- **Idle view.** A full-screen `WebView` on `cast_url`, JavaScript on, media autoplay on, cache enabled, cursor hidden, `FLAG_KEEP_SCREEN_ON`. If the page fails to load it keeps the last rendered frame and retries; after 60 s with nothing it shows the neutral idle (logo and clock). A doorbell ring reloads the web view, so a content push lands at once despite the slow kiosk poll.
- **Plan loop.** A foreground service fetches the plan every `poll_seconds` (600), reporting `mode` and `version`. It also subscribes to the Realtime doorbell channel for its device name (same anon key and channel shape as the Pi agent) and fetches on a ring, rate-limited to one fetch every 2 s. The plan is cached to disk with its `generated_at`.
- **Clock.** The agent measures skew between `server_now` and the device clock on each fetch and evaluates windows in server time. Generic boxes ship with wrong clocks; this removes the dependence.
- **Switching.** At `from` it launches `class_app_package` via `PackageManager.getLaunchIntentForPackage` (never a shell, never an arbitrary component; if the package is not installed it stays on marketing and reports `mode: 'unknown'`). At `until` it starts its own activity with `FLAG_ACTIVITY_NEW_TASK | FLAG_ACTIVITY_CLEAR_TOP`. An override replaces the window logic while it lasts. Boundaries are scheduled with `AlarmManager` exact alarms (the app is a system-like launcher; `SCHEDULE_EXACT_ALARM` is granted at provisioning) and re-checked on every fetch, so a missed alarm costs at most one poll interval.
- **Watchdog.** During a class-app window, every 30 s it checks the foreground task (`UsageStatsManager`, permission granted at provisioning); if the franchise app is not in front it relaunches it. Outside a window, if it is not itself in front it brings itself forward. This is what makes a crashed franchise app a 30-second blip.
- **Stale plan.** If the cached plan's `generated_at` is more than 24 hours old (the CRM has been unreachable for a day) the agent shows `stale_plan_mode`, which defaults to the franchise app: losing marketing for a day is the lesser harm. It keeps trying to fetch.
- **Boot.** `RECEIVE_BOOT_COMPLETED` starts the service; being the launcher brings the activity up.
- **Setup.** First launch with no credentials shows a setup screen: CRM base URL, device name, device token. Provisioning enters them over ADB (`am start … --es`) so nobody types a 50-character token on a TV remote; the token is stored in `EncryptedSharedPreferences` and never logged or displayed again.
- **What it never does.** Executes nothing derived from the network beyond "launch this installed package name" and "load this URL in the web view". No shell. No root.

### 7. Health

The fleet-health cron (`/api/cron/fleet-health`) today iterates the Tailscale device list and returns early, before grading anything, when Tailscale is unconfigured or unreachable; `gradeDevice` takes the Tailscale device object as its first argument. A screen is never in that list, so screens get their **own pass**: a `gradeScreens(db, nowMs)` step that reads `fleet_devices where role = 'screen'`, grades each on `last_heartbeat_at` alone (`SCREEN_OFFLINE_AFTER_MS`, 25 min = two 10-minute polls plus 5 minutes of slack, so one missed poll never pages; silence grades `unreachable`, `fleet_device_health.state` already admits it), writes `fleet_device_health` and runs `decideAlert` exactly as the Pi pass does. The screen pass runs **first and unconditionally**, before any Tailscale read, so a dark Hatch screen is noticed even if Tailscale is unconfigured in prod or down that minute. Screens are excluded from the Tailscale discovery and reachability signal (they have no tailnet hostname), and the discovery must not create a `fleet_devices` row for them or clear their `location_id`. `src/lib/fleet-health.test.js` pins that a screen with a recent heartbeat grades `ok` with no Tailscale row, that a 30-minute silence grades `unreachable` and a 20-minute one still grades `ok`, and that the screen pass runs when the Tailscale credentials are absent. Alerts go to the existing recipients (masters), which is accepted for now; routing a Hatch screen alert to Hatch staff is a follow-up on the alert path, not this design.

A second, softer signal is shown but not alerted in this version: when `reported_mode` disagrees with what the plan says the box should be showing, the fleet page marks the row "showing marketing during a class" in amber. Alerting on it is a follow-up once the first weeks show how often it is noise.

### 8. Permissions and security

- Configuring the automation: the `automations` permission plus a manager role at the studio, as the other automations.
- Overriding a screen: `fleet_restart` at the studio (safe tier).
- Registering a screen device, minting or rotating its token, linking its display: **master only**, matching the existing claim and token routes and their stated rationale (a device token is a credential for hardware in the gym). A new `POST /api/admin/fleet/devices` creates a row `{ device_name, location_id, role: 'screen', label, tv_display_id }` (Pis never needed it; they arrive through discovery), and `PATCH …/devices/[name]` accepts role `screen` and `tv_display_id` (the display must be active and at the same studio, else 400). Opening registration to `fleet_admin` (which owners hold by default) is a separate decision.
- Pushing marketing content: `tv_displays`, unchanged.
- The device token buys exactly: this device's plan (class names and times for the studio, the cast token for its display), and the ability to stamp its own heartbeat. It cannot set an override, read another device, or reach any other table.
- The plan endpoint, like the public TV routes, must never black out a screen because a limiter is down: the rate limiter fails open.
- `class_app_package` is validated at write (route) and at use (agent only launches an installed package by that name). It is a typed, validated field, which is the fleet's rule for an action that needs an argument.

### 9. Migration (one file)

1. `ALTER TABLE fleet_devices DROP CONSTRAINT …role_check; ADD CONSTRAINT … CHECK (role IN ('kiosk','bridge','screen'))`.
2. The six columns of §2, with their CHECKs and the FK to `tv_displays`.
3. No client grant on any of it: `fleet_devices` already has deny-all policies for `anon` and `authenticated`, and the new columns are read only by service-role routes.
4. No seed rows. The six devices are registered through the new create route and the fleet page once the boxes exist. Hatch's CRM `location_id` has existed for a long time (it is the un1t.online-connected studio); only `un1t-pi`'s `fleet.yaml` still says null, and that file is not read by this design.

`check:select-columns` will read the new column names from this file; name them in the route's `.select()` and the fleet page's read only after it lands.

### 10. What the boxes cannot do (and why that is fine)

The Pi fleet's actions (`restart_kiosk`, `reboot`, `shutdown`, `screenshot`, `pull_logs`, `redeploy_bridge`) all run as root over a shell. A non-rooted Android app cannot reboot the box, cannot screenshot another app without a per-use consent dialog, and has no journal to pull. The agent therefore accepts none of them, and the design does not try to emulate them. What it offers instead: the override (§5), the heartbeat with mode and version (§4), and the watchdog (§6). Updating the agent is an APK install over ADB on the gym network, documented in the setup guide; six boxes is few enough that this does not need an update channel yet.

### 11. Rollout

0. **Bench test, before anything else** (gating). One box on a desk with the franchise app and a signed debug build of UN1T Screen. Prove: (a) ADB over the network answers on the box; (b) the franchise app resumes cleanly after being backgrounded for an hour and after a reboot into the launcher (if it does not, this design is wrong and the fallback is to keep the franchise app permanently in front and revisit an HDMI-switch approach, so find out first); (c) the launcher reclaims the screen on boot; (d) the cast page renders a pushed image full-screen on the TV.
1. Migration, registry entry, plan endpoint, override route, device create route and `PATCH` widening, the screen pass in fleet-health, the `?kiosk=1` poll flag and doorbell ring on the cast content routes, fleet page section, hub card. Tests at each layer (route tests for the plan shape and the 404 behaviours; pure tests for window merging; the fleet-health pins).
2. Register `hatch-screen1`, link it to the "Hatch screens" display, mint its token, provision the bench box, enable `screen_mode` at Hatch with that one device. Hang it on one TV for a week. Watch the fleet page.
3. Provision the other five, add them to `device_names`.
4. Write `docs/screens-android-setup.md` (provisioning over ADB: install, set home activity, grant `PACKAGE_USAGE_STATS` and exact alarms, seed credentials, verify) and a changelog entry.

### 12. Left to the builder

- Android project structure, WebView hardening settings, the exact alarm and watchdog implementation.
- The merged-window algorithm's edge cases (a class that was cancelled mid-window: the next plan has no window, the agent returns to marketing at the next fetch).
- Card layout, within the house primitives (`@/components/ui`, light theme tokens).
- Whether the schedule preview route is extended or a sibling route is cleaner.
- The rate-limit key shape for the plan endpoint (per device name is natural, since all six share the gym's IP).

## Builder check (24 Oct 2026)

A reviewer who had not seen the conversation read this document against the code and raised four questions. All four were real; none needed Richard to answer, so they are settled above as designer's calls, listed here so they can be reversed:

| Finding | Call made | Where |
|---|---|---|
| The hub hides every curated card at Hatch behind the `schedule` capability, which un1t.online deliberately declares false. | Render the screens card outside that gate with its own availability test; leave the capability flag alone. | §3 |
| A 60 s plan poll on six boxes plus the cast page's 6 s poll in six web views is ~2.9 million requests a month, the cost class Richard already cut the Pi agent for. | Plan poll every 10 min; doorbell rings on override, content push and config save; `?kiosk=1` slows the cast poll to 60 s and a ring reloads it. Worst-case latency for a newly added class is ~25 min. | §4, §6 |
| The fleet-health cron only grades devices Tailscale lists, and exits early when Tailscale is unconfigured. | A separate, unconditional screen pass on `last_heartbeat_at`. | §7 |
| No route creates a `fleet_devices` row, and claim and token routes are master-only, not `fleet_admin`. | New master-only create route; registration stays master-only. | §8, §9 |

Three factual corrections were also applied: the cast page polls every 6 s (not ~3 s) and reads no query parameters today; Hatch's CRM location id exists; the fleet-health test file is `src/lib/fleet-health.test.js`.
