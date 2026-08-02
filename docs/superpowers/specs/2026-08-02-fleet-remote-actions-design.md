# FLEET-CMD.1 — remote actions for the Pi fleet

**Status:** design, not built
**Date:** 2026-08-02
**Follows:** BRIDGE-STATUS.1 (#1193), FLEET-ALERT.1 (#1194)
**Decisions taken with Richard, 2026-08-02:** all five actions; **master-only**; **desktop CRM only**.

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

**This feature adds no capability Richard does not already have.** With master-only scope it serves exactly one person, who owns both tools above. That is worth stating up front, because it sets the bar: the justification is *convenience and audit*, not access. Every hour spent here is an hour not spent on something only this feature can do.

Two things it genuinely adds:

1. **A record.** `pi run` leaves nothing behind. A command table says who restarted what, when, and whether it worked — which matters when a Pi has been misbehaving for a week and you are trying to remember what you already tried.
2. **No laptop, no shell.** Even on desktop, "click Restart browser" beats opening a terminal, recalling the device name, and waiting on SSH.

Richard chose **desktop only** over mobile-first. Noted and followed. It does mean the feature competes most directly with the CLI, which is the environment where the CLI is strongest — so keep the build small.

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

## Authorisation

Master-only, enforced in **three** places, because service-role routes bypass RLS entirely and app code is the only real gate:

1. the page (`/admin/fleet`) redirects non-masters
2. `POST /api/admin/fleet/commands` returns 403 for non-masters
3. RLS on `fleet_commands` denies `anon`/`authenticated` outright, as defence in depth

Every issued command records `issued_by`. With one master today that reads as pointless; it is not — it is what makes the table an audit log rather than a queue, and it is what lets this widen to managers later without a migration.

## The Pi agent

New, small, and it must exist on **all three roles** — the kiosks currently run Chromium and nothing else.

- Node (Trixie ships Node 20.19.2, so no NodeSource — same reasoning as the bridge role)
- one dependency: `@supabase/supabase-js`
- systemd unit, `Restart=always`, journald persistent (already configured by provisioning)
- hard-coded `ACTIONS` map, name → command → allowed roles
- reconnects with backoff; on reconnect it does **not** replay missed commands, because expiry already made them irrelevant

Delivered as a new component in `un1t-pi/src/roles/common.js` (it applies to every role), which means all three Stillorgan Pis need a `pi deploy` — this is not a CRM-only change.

## Phasing

**P1 — prove the path.** Migration, agent, `POST /api/admin/fleet/commands`, result endpoint, `/admin/fleet` page, actions `restart_kiosk` + `reboot` + `shutdown`, maintenance-window suppression. This is the whole architecture; the remaining two actions are additions to a map.

**P2 — the rest.** `redeploy_bridge` and `pull_logs`. `pull_logs` is separated because it is the only action that returns a *payload* rather than an exit code, which pulls in output truncation, a viewer, and a retention decision.

Ship P1 dark behind the absence of the agent: with no Pi running the agent, commands simply expire, and nothing else in the CRM changes.

## What this does not do

- **No arbitrary commands, ever.** `pi run` and Tailscale SSH remain the tools for that, and they should. The moment this grows a text box it becomes remote root execution with a web UI.
- **No mobile.** Richard's call. The mobile app is where "TV frozen, no laptop" actually bites, so this may want revisiting.
- **No scheduling.** Actions fire now or expire.
- **No fix for the black-screen kiosk.** A Pi that is up, on the tailnet, and showing nothing still reports healthy to fleet-health — `restart_kiosk` gives you a *remedy* to try, but not *detection*. That still needs device-side reporting.

## Open questions

1. **Does the agent replace or complement `pi deploy`?** Two paths to `git pull && restart` on the bridge will drift. Preference: the agent shells out to the same command string, sourced from one place.
2. **Output retention for `pull_logs`.** 300 journal lines per pull, kept forever, in a Postgres table, is a slow leak. Truncate to ~64KB and prune after 30 days?
3. **Should `restart_kiosk` verify?** `pkill` returning 0 means Chromium was killed, not that it came back. A 10-second re-check for the process would turn "command sent" into "browser is running", which is the thing you actually wanted to know.
