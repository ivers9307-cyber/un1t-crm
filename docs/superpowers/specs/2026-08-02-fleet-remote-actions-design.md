# FLEET-CMD.1 — remote actions for the Pi fleet

**Status:** design, not built
**Date:** 2026-08-02
**Follows:** BRIDGE-STATUS.1 (#1193), FLEET-ALERT.1 (#1194)
**Decisions taken with Richard, 2026-08-02:** all five actions; **two permission tiers split by blast radius**; **desktop CRM first**; location mapping in scope.

---

## What this is

Five named actions, exposed as buttons in the CRM, executed on a studio Raspberry Pi, audited.

FLEET-ALERT.1 made the fleet *observable* — the CRM now shouts when a Pi goes dark. This makes it *operable*: the answer to "the TV is frozen" becomes a button rather than a laptop, a terminal, and remembering the right incantation.

## What already exists — do not rebuild it

Two working tools already cover the ad-hoc case, and a third covers monitoring:

| Tool | Covers |
|---|---|
| `pi` CLI (`~/code/un1t-pi`) | `list` `status` `ssh` `run` `deploy` across all six devices |
| Tailscale browser SSH | a real shell on any Pi, from any browser, already enabled (`action: accept` in the ACL) |
| fleet-health cron | alerts when a Pi is unreachable or its bridge service dies |

**For Richard alone, this feature adds no capability he does not already have** — he owns both tools above. An earlier draft of this spec was master-only, and on that scope the honest justification was convenience plus an audit trail, which is thin.

The two-tier model is what changes that calculus. Three things it adds that neither tool can:

1. **It reaches people who are not Richard.** A coach can see the frozen board and now fix it. `pi` and Tailscale SSH will only ever be in one person's hands, however good they are.
2. **A record.** `pi run` leaves nothing behind. A command table says who restarted what, when, and whether it worked — which matters when a Pi has been flaky for a week and you are trying to remember what you already tried.
3. **No laptop, no shell.** Even for Richard, "click Restart browser" beats opening a terminal and recalling the device name.

## The five actions

| Action | Roles | What the Pi runs | Downtime |
|---|---|---|---|
| `restart_kiosk` | kiosk | `pkill -f chromium` — the launcher loop relaunches it in ~5s | ~5s |
| `reboot` | all | `systemctl reboot` | ~90s |
| `shutdown` | all | `systemctl poweroff` | **until someone physically power-cycles it** |
| `redeploy_bridge` | bridge | `cd ~/champ-bridge && git pull --ff-only && systemctl restart champ-bridge` | ~2s |
| `pull_logs` | all | `journalctl -n 300 --no-pager` for the role's unit | none (read-only) |

`restart_kiosk` and `redeploy_bridge` are lifted verbatim from `deployCommandFor()` in `un1t-pi/src/deploy.js`, so they are already hardware-proven. Do not reinvent them; if the command changes, it changes in both places or they drift.

### The security spine: the CRM never sends a command string

**The CRM sends an action *name*. The Pi maps that name to a command from its own hard-coded table and refuses anything it does not recognise.**

This is the single most important property in the design, and it must not be softened later for convenience. If the CRM sent shell text, then a compromised CRM session, a SQL injection, or a stray UPDATE on the command table would be **arbitrary root code execution on hardware sitting inside the gym**. With a name-based enum the worst a hostile row can do is reboot a Pi you already control.

Corollaries, all load-bearing:

- No parameters in v1. No "run this for me" escape hatch. If an action needs an argument later, it gets a typed, validated field — never free text.
- The Pi validates the action against **its own role**. A kiosk asked to `redeploy_bridge` rejects it and records the rejection; it does not try.
- The agent runs as a dedicated user with a narrow sudoers entry for exactly the three privileged verbs (`reboot`, `poweroff`, `systemctl restart champ-bridge`). Not blanket `NOPASSWD: ALL`.

### Shutdown needs different handling from everything else

`shutdown` is the only action that cannot be undone from a keyboard. A Pi 4 on a wall bracket has no usable wake-on-LAN over WiFi; a halted Pi returns when a human unplugs it and plugs it back in.

That is not a reason to refuse it — Richard has used it repeatedly today, cleanly halting a Pi before pulling its power or swapping an SD card, standing next to the device. That is the correct use, and a clean halt is better than yanking power from a live filesystem.

It is a reason to make the UI honest:

- confirmation requires **typing the device name**, not clicking OK
- the dialog states plainly: *"stillorgan-tv2 will stay off until someone physically power-cycles it"*
- the result row renders as `halted`, not `success` — the device is not coming back, and the list should not imply otherwise
- fleet-health suppression (below) is **indefinite** for a shutdown, not time-boxed

## Transport: how a command reaches a Pi

Richard's constraint, verbatim: *"i dont want the pi constantly polling for the few times a week itll get a command."* That rules out the obvious design and is why this spec exists.

**Chosen: Supabase Realtime `postgres_changes`.** The Pi holds one outbound WebSocket to Supabase and subscribes to INSERTs on `fleet_commands` filtered to its own `device_name`. Inserting the row *is* the push. No polling, no inbound port, no new vendor.

Why this one:

- **It is genuinely push.** One connection, opened once, idle until something happens. A week with no commands costs a week of an idle socket.
- **The table is the queue, the audit log, and the UI's data source at once.** No separate publish step to drift out of sync with the record.
- **The CRM already speaks it** — seven components subscribe to `postgres_changes` today, so the pattern and its failure modes are known here.
- **Zero inbound attack surface.** Nothing on the Pi listens.

Rejected, with reasons worth keeping:

- **Tailscale Funnel** — publishes the Pi to the **public internet** on 443 with **no built-in authentication**; anyone with the URL reaches it. We would be hand-rolling auth in front of a box inside the gym, to solve a problem that does not need an inbound listener at all.
- **Long-poll / SSE against a Vercel function** — functions cap at 300s, so the Pi reconnects ~288×/day per device. That is polling wearing a hat, and it fails Richard's constraint on the merits.
- **Piggybacking the bridge heartbeat** (commands returned in the 30s heartbeat response) — attractive because it adds nothing, but **only the bridge heartbeats**. The kiosks send the CRM nothing at all, and they are the devices most likely to need a button.
- **MQTT broker** — correct shape, new vendor, no.

### The Pi's credential

The Pi needs to authenticate to Supabase Realtime, and the anon key is not sufficient: it is public by design (it ships in the champ-app bundle), so an RLS policy permitting `anon` to read a command topic would let anyone holding that key watch fleet commands.

Each device therefore gets a **per-device JWT**, signed with the Supabase JWT secret, carrying a `device_name` claim. RLS on `fleet_commands` restricts each token to rows for its own device — SELECT only. Provisioning writes it to `/etc/un1t-pi/agent.env`, the same location and mechanism already used for the bridge's `champ-bridge.env` (deliberately outside the git clone — see the un1t-pi war story about `git clone` refusing a non-empty directory).

Blast radius if a Pi is stolen: the thief can watch that one device's command stream, read-only. They cannot issue commands and cannot see other devices. Revocation is a token rotation plus a `pi deploy`.

### Reporting results

The Pi does **not** write to the database directly. It POSTs to a narrow endpoint, `POST /api/fleet/commands/[id]/result`, authenticated with the same per-device token, and the route validates that the command belongs to the calling device.

Writing results straight to Postgres would need an RLS UPDATE grant on the Pi's token, which is a materially larger grant than "call one endpoint that only accepts a status and an output blob for a command addressed to you".

## Data model

```sql
create table fleet_commands (
  id            uuid primary key default gen_random_uuid(),
  device_name   text not null,          -- matches fleet_device_health.device_name
  action        text not null check (action in
                  ('restart_kiosk','reboot','shutdown','redeploy_bridge','pull_logs')),
  status        text not null default 'pending' check (status in
                  ('pending','claimed','succeeded','failed','rejected','expired')),
  issued_by     uuid not null references profiles(id),
  issued_at     timestamptz not null default now(),
  expires_at    timestamptz not null,   -- see below; NOT optional
  claimed_at    timestamptz,
  finished_at   timestamptz,
  exit_code     int,
  output        text,                   -- truncated; pull_logs uses this
  error         text
);
```

Indexed on `(device_name, status)` and on `issued_at desc` for the UI.

### Expiry is not optional

**A command that was not delivered must die, not queue.**

If a Pi is offline when you press Reboot, and the command simply waits, then the Pi reboots itself at whatever unrelated moment it next comes online — possibly mid-class, hours later, with nobody expecting it. That is a worse failure than the button not working.

`expires_at = issued_at + 2 minutes`. The Pi checks expiry itself before executing (its clock is NTP-synced — provisioning waits for `timedatectl` before installing anything, precisely because a Pi has no RTC), and a sweeper marks stragglers `expired`. The UI says "not delivered — the Pi was offline", which is true and actionable, rather than leaving a live grenade in a queue.

Two minutes is deliberately tight. These are interactive actions; if it did not land while you were looking at the screen, you want to know, not to have it happen later.

## Interaction with FLEET-ALERT.1 — this matters

`reboot` and `shutdown` make a device unreachable **on purpose**. fleet-health grades unreachable-past-15-minutes as an outage and pages the masters. Without handling, every reboot you initiate pages you about the reboot you initiated — and the entire value of that alert rests on it never crying wolf.

**Maintenance window.** When a `reboot` or `shutdown` is claimed by a device, stamp `fleet_device_health.suppressed_until`:

- `reboot` → `now() + 10 minutes` (a reboot is ~90s; the margin covers a slow apt-dirty boot)
- `shutdown` → **indefinite**, cleared when the device next reports in

`gradeDevice()` gains no new logic — this belongs in `decideAlert()`, which already owns "should anyone be told". A suppressed device still *grades* `unreachable` and still shows as down in any UI; it simply does not alert. Suppressing the grade rather than the alert would make the admin surface lie, which is the exact bug BRIDGE-STATUS.1 existed to fix.

**The failure mode to watch:** a Pi that is rebooted and never comes back is now silent for 10 minutes and then alerts normally. That is correct. A Pi that is *shut down* and never comes back never alerts — also correct, because you turned it off, but it means a forgotten shutdown is invisible. Mitigate with a standing list on the page: **"Devices you have powered off: stillorgan-tv2, since 16:40 yesterday."** Not an alert; a visible piece of state that a human can notice.

## Authorisation — two tiers, split by blast radius

The axis is **what the action can break**, not how senior the person is. This mirrors `equipment_admin` vs `equipment_inspect`, where setup is owner+master on desktop and the walk-round is universal on mobile.

| Key | Actions | Default |
|---|---|---|
| `fleet_restart` | `restart_kiosk`, `pull_logs` | on for coach, head coach, manager, owner, master — anyone on shift |
| `fleet_admin` | `reboot`, `shutdown`, `redeploy_bridge` | owner + master only |

The reasoning is about who is standing next to the problem. A frozen leaderboard is noticed by a coach mid-class. Today the fix path is coach → messages Richard → Richard finds a laptop → SSH → `pkill chromium`, which is hours of dead screen for a five-second fix, and the bottleneck is one person. `restart_kiosk` cannot destroy anything: worst case someone presses it twice and the board blinks. Handing that button to the person who can already see the problem is the only thing this feature does that the `pi` CLI and Tailscale SSH structurally cannot, because those will only ever be in Richard's hands.

Everything that can strand a device stays behind `fleet_admin`.

Enforced in **three** places, because service-role routes bypass RLS entirely and app code is the only real gate:

1. the page redirects anyone without at least `fleet_restart`
2. `POST /api/admin/fleet/commands` checks the **per-action** key — not the page's key — and 403s otherwise
3. RLS on `fleet_commands` denies `anon`/`authenticated` outright, as defence in depth

Location scope rides on the existing mechanism: non-masters may only act on devices at a location in `getUserLocationIds(user)`, exactly as `/api/live/[locationId]/*` already does. That is what makes the location mapping below load-bearing rather than cosmetic — without it there is no way to stop a Stillorgan coach restarting a Hatch TV.

Every command records `issued_by`, which is what makes the table an audit log rather than a queue.

### The surface tension worth naming

Richard chose desktop-first. The safe tier's whole rationale is a coach holding a phone on the gym floor, and that value is **mostly unrealised until this is on mobile** — a coach mid-class is not walking to a desktop. The front-desk studio shell (`studio_devices`, PIN login) partly covers it, so desktop-first is not useless, but P3 below is where the coach tier actually starts paying.

## Location mapping — much smaller than it looked

I estimated this at half a day of extra work. That was wrong, and the correction matters because it changes what P1 costs.

**The workout-results pipeline Richard needs this for already exists, and is already location-scoped.** Checked against the live database:

- `contact_devices` permanently binds a strap to a member, and `resolveStrapsForBatch` auto-routes it to that member's session **every future class** — this is the "map workout results to the customer profile" path, and it is built
- `hr_samples.session_id` carries results to a session, and from there to a contact
- the entire `/api/live/[locationId]/*` surface is per-location, coach-role gated, and already enforces `getUserLocationIds(user)`
- `ble_bridges` carries **both** `location_id` and `tailscale_hostname`, populated in production: `stillorgan-bridge` → UN1T Stillorgan
- `tv_displays` carries `location_id` per screen

So `device_name → location` already joins **for the bridge**, via the `tailscale_hostname` column FLEET-ALERT.1 added for an unrelated reason.

**That join is not the model to generalise from.** `ble_bridges` became the CRM's de facto device registry by accident of build order — it was built first, for HR — and taking it as the template makes every other Pi look like a special case of a bridge. It isn't. The bridge is one role among three, and it holds no privileged position: no kiosk routes through it, and at runtime a kiosk talks only to the CRM (`roles/kiosk.js:59` points Chromium at `${crmBaseUrl}/tv/${location_id}?kiosk=1`).

**The kiosks already know their own location.** `fleet.yaml` carries `location_id` per site, and provisioning bakes it into that Chromium URL. Every Pi has known where it lives since the day it was imaged. The CRM simply never wrote it down — `tv_displays` holds a display *registration* (a token for a browser to pull content), not a record of the machine driving the screen.

So this is not new information to go and discover. It is the CRM catching up with the manifest.

### `fleet_devices` — the primary record for every Pi

```sql
create table fleet_devices (
  device_name text primary key,        -- matches the Tailscale hostname
  location_id uuid not null references locations(id),
  role        text not null check (role in ('kiosk','bridge')),
  label       text                     -- "TV 1 (leaderboard)"
);
```

Seeded from `fleet.yaml`, which is already the source of truth for what exists. `fleet_device_health.device_name` gains a foreign key to it.

Why a registry rather than bolting `location_id` onto `fleet_device_health`:

- **every Pi is a first-class row, whatever its role.** `ble_bridges` stops being the registry and becomes what it should always have been: bridge-specific detail (HR token, strap state, service status) hanging off a device that already exists. A kiosk is not a bridge with missing columns
- it carries **`role`**, which the action model needs anyway — `restart_kiosk` must not be offered for a bridge, and `redeploy_bridge` must not be offered for a kiosk
- `fleet_device_health` becomes health *about* a known device, rather than a free-floating row keyed on a string that arrived from Tailscale. Today a typo'd hostname silently creates a phantom device
- it does not overload `tv_displays`, which means a registered *screen*, not a computer

Not doing: parsing `stillorgan-` off the front of the hostname. That is exactly the clever-looking shortcut behind this morning's dead-code defect, where `hardware_id` and the Tailscale hostname looked related and weren't.

Realistic cost: one table, one seed, one join in the existing cron. Well under the half-day I quoted, because the hard part — results to member, scoped per location — was already built.

## The Pi agent

New, small, and it must exist on **all three roles** — the kiosks currently run Chromium and nothing else.

- Node (Trixie ships Node 20.19.2, so no NodeSource — same reasoning as the bridge role)
- one dependency: `@supabase/supabase-js`
- systemd unit, `Restart=always`, journald persistent (already configured by provisioning)
- hard-coded `ACTIONS` map, name → command → allowed roles
- reconnects with backoff; on reconnect it does **not** replay missed commands, because expiry already made them irrelevant

Delivered as a new component in `un1t-pi/src/roles/common.js` (it applies to every role), which means all three Stillorgan Pis need a `pi deploy` — this is not a CRM-only change.

### The agent gives the kiosks a voice — which closes the black-screen gap

Today the bridge grades on two signals (tailnet reachability **and** `deriveBridgeStatus` over `ble_bridges.last_seen_at`), while a kiosk grades on reachability alone. That asymmetry is not architectural favouritism — the bridge is simply the only device currently running software that talks back. But it is why **a kiosk that is powered, on the tailnet, and displaying a black screen still grades `ok`**, which is the most likely real-world failure and the one fleet-health cannot see.

Putting an agent on every Pi fixes that as a side effect, and the fix belongs here rather than in a dependency on the bridge:

- **Liveness comes free from Realtime presence.** The agent already holds the connection; presence tells the CRM it is there without a single extra request.
- **State is reported on change**, not on a timer — Chromium exited, the page failed to load, the last successful render timestamp. A low-frequency keepalive (~5 min) covers the case where nothing changes.

`gradeDevice` then takes a third input alongside `bridgeRow`: an agent report. A kiosk reachable on the tailnet whose agent says Chromium is dead grades `degraded` and alerts, instead of grading `ok` and lying.

**Trap, and it is a real one:** presence is *instant*, and wiring it straight to alerting would page you on every WiFi blip and every 04:00 reboot — destroying the property FLEET-ALERT.1 was built to protect. The 15-minute patience and the maintenance window stay exactly as they are. Presence enriches the grade; it does not shorten the fuse.

**On the polling objection:** this is not the thing Richard rejected. That was a Pi making repeated empty round-trips *to ask whether a command exists*. Presence costs nothing per interval, and a state report only happens when there is something to say. Every message carries payload.

## Phasing

**P1 — prove the path.** `fleet_devices` registry + seed, `fleet_commands` migration, the Pi agent, `POST /api/admin/fleet/commands`, the result endpoint, the page, actions `restart_kiosk` + `reboot` + `shutdown`, both permission keys, and maintenance-window suppression. This is the whole architecture; the remaining actions are entries in a map.

**P2 — the rest of the actions, plus agent reporting.** `redeploy_bridge` and `pull_logs`; `pull_logs` is separated because it is the only action returning a *payload* rather than an exit code, which pulls in truncation, a viewer, and a retention decision. Agent reporting lands here too — presence plus on-change state, and the third input to `gradeDevice` — which is what finally makes a black-screen kiosk visible.

**P3 — mobile for the safe tier.** `fleet_restart` on the mobile app, `webEquivalent: 'fleet_restart'`. This is where the coach tier stops being theoretical, per the surface tension above.

Ship P1 dark behind the absence of the agent: with no Pi running it, commands simply expire and nothing else in the CRM changes.

## What this does not do

- **No arbitrary commands, ever.** `pi run` and Tailscale SSH remain the tools for that, and they should. The moment this grows a text box it becomes remote root execution with a web UI.
- **No mobile in P1.** Deferred to P3 rather than dropped, because the coach tier is where the feature earns its keep and a coach is holding a phone.
- **No scheduling.** Actions fire now or expire.
- **The black-screen kiosk is fixed in P2, not P1.** P1 ships the *remedy* (`restart_kiosk`); detection arrives with agent reporting. Until then a dark screen still grades `ok`.

## Open questions

1. **Does the agent replace or complement `pi deploy`?** Two paths to `git pull && restart` on the bridge will drift. Preference: the agent shells out to the same command string, sourced from one place.
2. **Output retention for `pull_logs`.** 300 journal lines per pull, kept forever, in a Postgres table, is a slow leak. Truncate to ~64KB and prune after 30 days?
3. **Should `restart_kiosk` verify?** `pkill` returning 0 means Chromium was killed, not that it came back. A 10-second re-check for the process would turn "command sent" into "browser is running", which is the thing you actually wanted to know.
