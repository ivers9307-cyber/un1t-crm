# Floor screens: the class app during class, marketing the rest of the time (SCREENMODE)

> Built 2026-10-24 on `hatch-screen-mode` (migration 768). Operator guide to the CRM side. Design: `docs/superpowers/specs/2026-10-24-hatch-screen-mode-design.md`.

**What it is.** Six Android TV boxes at UN1T Hatch Street, one per TV, each showing the franchise class app during a class and marketing content the rest of the time. Each box is a `fleet_devices` row with `role = 'screen'`. It asks the CRM for a plan (`GET /api/fleet/screen-plan`) using its own per-device token, and acts on that plan locally. The CRM decides; the box obeys.

**What this doc does not cover.** The Android agent ("UN1T Screen") that runs on the box. Its provisioning guide (install, set as home app, grant permissions, seed credentials) lives in the `un1t-screen` repository.

---

## 1. Register a screen (master only)

On `/admin/fleet`, in the **Screens** section, use **Register a screen**:

| Field | What to enter |
|---|---|
| Device name | `hatch-screenN`: `hatch-screen1` to `hatch-screen6`. Lower case, digits and hyphens only. |
| Label | Where it hangs, for example "Rig wall left". This is what staff see in the list. |
| Location | UN1T Hatch Street. |
| Display | **Hatch screens**: the shared cast display that all six boxes render when no class is on. Pick it so the box has marketing to show. |

Registering is master-only: a device token is a credential for hardware in the gym, so who may create a screen is a registry decision, not a floor-staff one. The migration (768) must be applied to production before the page can register anything.

## 2. Issue the device token

On the screen's row, press **Issue agent token** (**Rotate agent token** if it already has one). The token is shown **once**.

- It goes into the box at provisioning, entered by the person doing the install, and nowhere else.
- Never paste it into chat, a ticket, an email or a file in any repository.
- Lost it, or think it leaked? Press **Rotate agent token**: the old one stops working at once and the new one is shown once.

The token buys exactly this box's plan and its own heartbeat. It cannot set an override, read another device or touch any other table.

## 3. Turn on Class screens at Hatch

On `/automations`, with Hatch Street selected, find the **Class screens** card (it sits outside the class-schedule gate, so it shows at Hatch even though un1t.online declares no schedule capability).

1. **Which screens follow the timetable**: tick the screens.
2. **Class app package**: the Android package name of the franchise class app on the boxes (for example `com.example.classapp`; the real one comes from the app on the box).
3. **Show class app (min before)**: default 10. **Keep it (min after)**: default 5.
4. Optional: **Only these classes** (blank is all), and excluded weekly slots (click a class in Today's plan).
5. **Save settings**, then switch the card **On**.

**Today's plan** on the same card lists the windows when the screens will show the class app, so you can check the day before it happens. Back-to-back classes merge into one continuous window. A class with no end time counts as 60 minutes.

## 4. What the fleet page shows

Each screen row on `/admin/fleet`:

| Column | Meaning |
|---|---|
| Last seen | When the box last fetched its plan. "Never" until it first does. It fetches every 10 minutes and whenever it is rung. |
| Showing | What the box last reported: **Class app** (blue), **Marketing** (green), **Unknown** (grey: the box could not tell, for example the class app is not installed). |
| Should show | What the CRM's plan says it should be showing now. A dash means Class screens is off at this studio, so there is no expectation to compare against. |
| Override | If a staff override is in force: its mode and how long it has left. |
| Amber "showing marketing during a class" | The box reports marketing while the plan says class app. Shown for people to see; it does not alert. |

## 5. Overrides

Three buttons per screen (anyone with `fleet_restart` at the studio sees them):

- **Show class app for 1 h**
- **Show marketing for 1 h**
- **Back to schedule** (clears the override)

An override beats the timetable on that one screen for the chosen time, then lapses on its own and the box returns to the schedule. The buttons set 60 minutes; the API also accepts 30, 120 or 240. The CRM rings the box so it changes within seconds rather than at its next 10-minute fetch. Use it when a class was added too close to its start for the normal path (see section 7), or to put marketing up during an open day.

## 6. Marketing content

Marketing is whatever staff push to the linked TV display on `/admin/tv-displays` (the box loads `/tv/cast/<token>?kiosk=1`). Push or clear content there as for any TV display; every screen linked to that display changes. Nothing is managed on the fleet page for content.

## 7. How fast does a change arrive

| Change | Reaches the screen |
|---|---|
| Content pushed or cleared on the display | Seconds. The push rings the box's doorbell and it reloads. |
| A staff override, or saving the Class screens card | Seconds (same doorbell). |
| A class added or moved in un1t.online | Up to about 25 minutes: the un1t.online sync runs every 15 minutes, then the box picks the new plan up on its 10-minute poll. |

A class added closer to its start than that is what the override button is for. The plan covers the next 36 hours, so the poll is a backstop, not the mechanism: a box already holds this morning's classes.

## 8. When something goes wrong

- **CRM or internet down:** the box keeps acting on its cached plan, so a class is never lost to an outage (marketing may not refresh).
- **No fresh plan for 24 hours:** the box stops trusting its cache and shows the class app (the configured stale-plan mode, default `class_app`). Losing marketing for a day is the lesser harm. It keeps trying to fetch.
- **No heartbeat for 25 minutes:** the fleet-health cron grades the screen `unreachable` and **alerts masters** (the existing fleet alert recipients). The check runs even when Tailscale is down or unconfigured, because screens are not on the tailnet. Routing a Hatch screen alert to Hatch staff is not built.
- **Black screen:** the agent is designed never to show one; if it cannot decide it shows the class app.

The Pi actions (restart browser, reboot, screenshot, pull logs) do not exist for screens; the fleet page offers none of them on a screen row.

## 9. Plan contract for the agent

For whoever builds or changes the UN1T Screen app. The box calls `GET /api/fleet/screen-plan` every `poll_seconds` (600) and on each doorbell ring. How it must treat each answer:

| Answer | Meaning | The agent |
|---|---|---|
| **200** | A trustworthy plan. | Replace the cached plan and reset the stale clock (the 24-hour rule in section 8). |
| **503** `{ "error": "plan_unavailable", "degraded": "…" }` | The CRM could not read the automation, the class occurrences or the studio timezone, so it cannot say what is on today. The heartbeat was still recorded. | Keep the cached plan, retry on the next tick, and **do not** reset the stale clock. |
| **401** | Token rejected, or the CRM could not look the token up. The CRM folds a database error into 401, so 401 never means "this box was de-provisioned". | Keep the cached plan and retry. Never wipe the token or the plan on a 401. |
| **429** | Rate limited. | Back off to the next tick. |

A 200 may carry `degraded: "display_unreadable"`: the windows are fine, only `cast_url` is null for now. Use the plan; the idle screen shows until the display reads again. Any other status (404, 500) is also "keep the cache and retry".
