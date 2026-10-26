# Shelly Groups, Lights and Class Schedules — Design

**Date:** 2026-10-26
**Status:** Draft for Richard's approval (builder-checked 2026-10-26)
**Repo:** un1t-crm
**Builds on:** `docs/superpowers/specs/2026-08-22-shelly-device-control-design.md` (v1: per-device schedules, the exactly-once planner, the per-minute reconcile, tenancy rules). Everything in that spec still holds unless this one says otherwise.
**Mockups:** approved in conversation on 2026-10-26: the phone "Smart plugs" screen with groups, and the web group schedule editor with a day preview strip. They are reproduced in words under [Screens](#screens).

## Why

Richard runs Stillorgan's lights, ventilation and bathroom fans from Shelly. Three problems with v1:

1. **Devices are missing.** Two Shelly Plus RGBW PM LED controllers (`SNDC-0D4P10WW`) show up in Discover as "Not supported yet", because v1 only knows on/off relays (`switch:N`). Those lights are needed.
2. **No groups.** Staff switch plug by plug. They want "Gym floor lights" (or "Bathrooms") as one thing to turn on and off.
3. **Class schedules don't fit the gym.** Today's class mode makes one window from before the first class to after the last, so a device stays on all day between classes. Richard wants devices to come on around classes and go off between them. Schedules should be set per group, not per device.

He also dislikes how both the phone and web screens look today. The approved mockups replace them.

**State of prod (checked 2026-10-26):** Stillorgan is the only Shelly connection. It has six adopted Shelly 1 Mini Gen3 relays, all `enabled=false` and `schedule_mode='none'` with a manual override. **No device runs a schedule today**, so moving schedules from devices to groups breaks nothing that is live.

## Decisions (Richard, 2026-10-26)

1. **Groups have their own schedules.** A group's schedule applies to every device in it.
2. **Class rules use the whole timetable.** There is one room, so *any* class on the location's timetable counts. Rules by class name or type are explicitly not wanted ("a per class automation is unnecessary"). Choosing days and times is enough.
3. **LED controllers are supported, on/off only.** A light comes on at **whatever brightness it was last set to** (in the Shelly app or on the device). The CRM never sends a brightness, colour or temperature. No sliders and no colour pickers.
4. **Both mockups are approved:** phone (groups with one switch each, devices listed underneath) and web (a group schedule editor plus a day preview).
5. **Preview before trusting it.** The web shows a day timeline of classes and each group's on/off periods, steppable day by day.

## Goals

- Adopt and control Shelly LED controllers (light components) alongside relays, in the same lists, groups and schedules.
- Named groups per location. One switch turns a group on or off from the phone and the web, with the same override presets as today (until midnight, 1 h, 3 h; "back to schedule").
- Group schedules: **never automatic**, **fixed hours** (days + times, the existing window shape), or **follow classes** (on N min before each class, off M min after, on chosen weekdays, with short gaps joined).
- A day preview of what the schedule will do, computed by the same engine the cron runs.
- The redesign of both screens per the mockups, including a banner when the Shelly account has devices not set up at this location.

## Non-goals

- Brightness, colour, colour temperature or effects for lights. Ever-present on/off only.
- Class rules by class name, type, instructor or room.
- Covers/rollers (`set/cover`), Gen1 devices, BLU devices.
- Moving the energy chart, connection panel or discovery logic beyond what the redesign needs. They keep working as they do.
- On-device schedules, `toggle_after` safety caps, drift detection and alerts. These were recommended separately and are not part of this project.

## Anti-goals (failure even if it "works")

- **A light switching on at a different brightness from the one staff set.** Sending `on:true` alone must restore the device's last level. If the live gate shows it does not (see [Live gate](#live-gate)), stop and come back. Do not invent a brightness.
- **A group switch that reports "on" while some members silently failed.** Partial success must be visible ("1 of 2 on", amber).
- **Lights left on all day** because a class schedule held them on between widely spaced classes.
- **Breaking tenancy:** no route takes a `location_id`; a group can only contain devices of its own location; a device id still serves exactly one location.
- **The cron fighting a human.** v1's rule stands: a physical change between boundaries is never undone.

## Constraints

- Everything in `CLAUDE.md`'s invariants applies, notably for this work:
  - service-role routes enforce location access in app code;
  - new tables are closed to clients by default (mig 677) and need an explicit grant decision;
  - forward-only migrations, applied before the code that depends on them;
  - `check:select-columns` / `check:rpc-names` / `check:location-scoping`;
  - `.select()` must name its columns where rows reach a client component.
- **Shelly's 1 request/second per account** still governs. Group commands must go through `set/groups` batches, not a per-device loop, wherever possible. `set/groups` accepts `switch` and `light` groups in one request (Communication v2.0-beta).
- Phone: mobile cannot import `src/lib`; shared logic goes through `shared/` or is re-typed, as `mobile/lib/shelly.js` does today. **Any change under `mobile/` publishes an OTA to every phone on merge** (CLAUDE.md), so the phone redesign must be finished and tested before it lands.
- No new permission key. Everything rides `device_control`, as today. Group *management* (create, rename, membership, schedule) follows the same rule as device schedules today: web only, `device_control`.

## The how, as decided

### Devices: one more kind

`shelly_devices` gains a `kind` column (`'switch' | 'light'`, default `'switch'`). A light row's `channel` is the light component's index.

- **Status:** the normaliser (`src/lib/shelly/status.js`) learns `light:N` alongside `switch:N`. A light's reading is `output` (on/off), `brightness` (for display only), `apower` when the device meters it, and `aenergy`. The RGBW PM in `rgb`/`rgbw` profile exposes a single `rgb:0` / `rgbw:0` component instead. Treat that as one light, channel 0. The "supported" verdict becomes "has a switch OR a light component".
- **Commands:** the client gains `setLight(id, channel, on)`, which sends `set/light` with **`on` only**. `setGroups` grows a `light` group beside `switch`, so one request can switch a mixed group.
- **Discovery** offers lights for adoption like relays, so the "Not supported yet" chip disappears for them.
- **Energy:** lights with `aenergy` roll into `shelly_energy_daily` exactly like relays; lights without it simply have no chart.

### Groups

New table `shelly_groups`, one row per group:

- `location_id` (FK, cascade), `name`, `icon` (from a small fixed list: bulb, fan, tv, plug, droplet), `sort_order`.
- The schedule, in the same vocabulary as devices today: `enabled`, `schedule_mode` (`none | fixed | class`), `fixed_windows`, `class_rule`.
- `override` (`{state, until, set_by, set_at}`) and `last_applied`, with the same meaning as on a device.

`shelly_devices` gains a nullable `group_id` (FK to `shelly_groups`, `ON DELETE SET NULL`). A device is in **at most one group**. A trigger or check must refuse a `group_id` whose group is at another location. Same-location-only is a database rule, not just app code (the mig-554 pattern).

**Which schedule governs a device:**
- **In a group:** the group's `enabled`, schedule and override govern it; the device's own `enabled` and schedule fields are not consulted. **Joining a group clears the device's own schedule** (`schedule_mode='none'`, empty windows/rule) so that leaving a group can never revive a stale, invisible schedule (my call, from the builder check). Adding a device to a group is the explicit act of handing it to that group's schedule, and the "Edit devices" UI says so.
- **Per-device switch under a group:** still exists (the broken-fan case) and writes a device-level override that wins over the group's *schedule* until it expires. **But pressing the group's switch, or the group's "back to schedule", clears every member's device override first — the group wins** (Richard, 2026-10-26). "1 of 2 on" therefore only ever means a member that failed, is offline, or was switched separately *after* the last group press.
- **Leaving a group / group deleted (`ON DELETE SET NULL`):** the device becomes ungrouped with mode `none` and is left physically as it is ("stays until changed", as v1's disable). Its `last_applied` is kept; nothing is switched (my call).
- **Not in a group:** it behaves exactly as v1.

**Group switch semantics:** pressing a group's switch writes an override on the group, then sends one `set/groups` call for every member (switches and lights together). It answers per member: all landed (`applied`), some pending (`partial`, naming which), or none (`pending`, as the device toggle does today). The phone shows the switch **amber** when members disagree. This is a display state ("1 of 2 on"), not a third command.

### Class schedules: per-class windows

`class_rule` becomes `{lead_min, lag_min, merge_gap_min, days}`:
- `days` is ISO weekdays 1–7 (default all seven).
- `merge_gap_min` defaults to **30**: if the off time of one class window is within this many minutes of the next class's on time, the two windows join and the group stays on.

**My call:** the merge default of 30 min, and lead/lag defaults staying at 15/10 — single constants, cheap to change.

For the location's local day, every non-cancelled `class_occurrences` row on a chosen weekday becomes a window `[starts_at − lead, ends_at + lag)`. Overlapping or close windows are joined, and each joined window's key is `w:<on_at ms>` as today. This replaces the single first-to-last window in `resolveDayWindows`. All v1 safety rules carry over:
- fetch exactly the local day;
- a failed occurrence read skips class-mode groups for that tick, never switches them off;
- a class crossing local midnight is cut at midnight.

Because no device uses class mode in prod, the semantics change can land without a migration of existing rows. The device-level class mode (for ungrouped devices) gets the same per-class windows, so there is one engine.

### Preview

`GET /api/shelly/groups/[id]/preview?date=YYYY-MM-DD` (and a location-wide variant for the multi-lane strip) returns the day's class blocks and each group's resolved on-windows, **computed by the same pure engine the cron calls**. It never reimplements the rules in the browser. The response states what it ignored, such as a live override, so the strip never lies about a day the override will change.

### Screens

**Phone — Studio → Smart plugs** (the approved mockup):
- **Header:** "Smart plugs", the studio name, the next class, total watts now, and a refresh button.
- **iOS home-screen widget:** unchanged in this project; it keeps its per-device toggles (group buttons would need native work and a store build; my call). A widget press on a grouped device is a device override like the per-device switch above.
- **Missing-device banner:** "N devices on your Shelly account aren't set up here". Shown when discovery finds unadopted, adoptable devices. Read-only on the phone; adopting stays on the web.
- **Group cards:** icon, name, and a reason line ("Follows classes · on until 19:10", "Fixed hours · 06:00–21:00", "1 of 2 on · manual until midnight"). One switch per group (green on, grey off, amber mixed), with the members listed underneath: status dot, name, watts or an "Offline" chip, and their own small switch.
- **Not in a group:** a final card for ungrouped devices, each with its own switch.

**Web — `/automations/shelly`** (the approved mockup):
- **Group cards** carry the schedule editor: three choices (never automatic / fixed hours / follow classes), the lead, lag and gap selects, and days. An "Edit devices" control assigns members.
- **Day preview strip:** one lane for classes, one per group. Step day by day; a line explains any joined windows.
- **Device cards** shrink. Their schedule editor appears only for ungrouped devices.
- **Discovery** shows lights as adoptable. Connection panel and energy chart are unchanged apart from styling.

## Live gate

**Who and when (my call):** the lights backend PR (normaliser, `setLight`, adopt) merges first; Richard then adopts the two RGBW PMs and presses On/Off from the web while the builder reads the logged component shape. Groups build on it only after the gate passes. **If the real component is `rgb:0`/`rgbw:0` and `set/light` or a `light` group entry cannot drive it, stop and report** — no new command path is invented without coming back.

Before the light work is called done, against Stillorgan's real RGBW PM controllers:
1. A `get` shows which component they expose (`light:N` or `rgb:0`/`rgbw:0`). The normaliser must match the real body, not the docs.
2. `set/light {on:true}` with no brightness restores the level last set in the Shelly app. **If it does not, stop and report back.**
3. A mixed `set/groups` (one relay plus one light) answers 200 and both move.

## Left to the builder

- Table and column details beyond those named, index choices, RLS/grant statements (closed to clients, per mig 677 and the phone reading through `/api` as today).
- Route shapes for group CRUD, group toggle and membership (`withAuth('device_control')`, no `location_id` parameter, 404 on foreign ids), and their OpenAPI entries.
- How the reconcile batches group members into `set/groups` per direction while keeping exactly-once stamps per device.
- Visual details within the approved mockups, using the house tokens.
- Test layout, following the v1 pattern: pure engine tests under `TZ=Europe/Dublin` and `TZ=America/New_York`, client tests against mocked fetch, reconcile tests with a fake db, route tests including cross-tenant cases.
- Splitting into PRs. Suggested order: lights backend → groups + per-class engine → web screens → phone screen (last, because it ships as an OTA).
