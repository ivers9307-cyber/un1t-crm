# Class Timer (Myzone-style interval clock) — design

**Date:** 2026-06-18
**Status:** Approved design, pre-implementation
**Ticket prefix:** CLASS-TIMER
**Related:** [[class-climate-v0]] (the `class_occurrences` schedule spine), [[champ-bridge-hr-live]] (the HR board this displays alongside), HR-CLASS-ALLOC.1/.2 (the `/tv` + `/live` surfaces)

## Motivation

Richard wants a Myzone-style class timer displayed alongside the live HR board: a
big interval clock on the gym TV, driven (start/pause/stop/skip) from a coach's
phone or a web page. Classes are "custom" — coaches define the class time,
intervals and splits. This is the interval-timer / workout-clock that anchors a
structured class (HIIT, circuits), shown next to the HR leaderboard that already
drives engagement.

## Decisions captured (from brainstorming)

1. **Timer model = flexible segments.** Not a fixed countdown/interval/station
   format — one engine that expresses all three: an ordered list of named blocks,
   any block repeatable for N rounds.
2. **TV layout = banner on top.** An information-rich command strip across the top
   of the existing `/tv/[locationId]` board; the HR leaderboard fills below.
3. **Authoring = reusable templates + manual start**, with an **optional** link so
   a template can auto-load when a chosen Glofox class is live. Manual start is
   always available.
4. **Control = mobile + web both.** The staff mobile app (phone on the class
   floor — the real use) and a web control page. The TV is display-only.
5. **Sync = server-authoritative state + client-computed countdown** (not
   realtime). The server holds the authoritative run state; every display computes
   the live tick locally from `started_at`.

## The core insight — the server never streams the clock

The hard part of a synced timer is making N screens tick in lockstep without a
firehose of updates. The model that avoids it:

- The server stores the **authoritative state**: which template, status
  (running/paused/finished/stopped), `started_at`, accumulated pause time, and a
  skip offset. It does **not** tick.
- Every display (TV, web control, mobile control) computes the **effective
  elapsed** = `(now − started_at − paused_accum − livePause) + elapsed_offset`,
  resolves that against the template timeline to get *current segment + remaining
  seconds + round*, and renders a smooth local countdown (a `setInterval`/rAF in
  the client).
- The existing poll (the TV already polls `/api/public/live` every 2s) only
  **corrects drift** and **picks up transitions** (pause/skip/stop). A late-joining
  TV computes the correct position instantly from `started_at`.

Clock drift between client and server is corrected by anchoring on the
`server_time` the poll already returns (the TV response includes `server_time`).

**Why not Supabase Realtime** (the considered alternative): it would reflect a
pause/skip ~1-2s faster, but (a) you still compute the per-frame tick locally
regardless — realtime never streams every second — so it only speeds up
*transitions*, and (b) the public TV route is anon; wiring anon Realtime +
RLS on a public board is real complexity for ~1s saved. Polling + local countdown
is simpler and robust. (If transition latency ever matters, realtime can be added
behind the same state model without reshaping it.)

## Components (isolated units)

### 1. `src/lib/class-timer.js` — the pure engine (the brain)

All logic, no IO. Unit-tested exhaustively. This is the unit everything else
depends on; keep it pure so it's trivially testable and reusable on web + mobile.

- `validateStructure(structure)` → `{ ok, error? }`. A structure is an ordered
  array of blocks; each block is either
  `{ kind:'segment', label, type:'prep'|'work'|'rest'|'station'|'custom', seconds }`
  or `{ kind:'round', count, segments:[ ...segment blocks ] }`. Bounds: 1..N
  blocks, seconds 1..3600, count 1..99.
- `buildTimeline(structure)` → flat `steps[]`, each
  `{ index, label, type, seconds, roundIndex, roundCount, startMs, endMs }`
  (rounds expanded; `roundIndex/roundCount` carried for the "Round 3/8" display;
  `startMs/endMs` are cumulative offsets). Also returns `totalMs`.
- `computeEffectiveElapsedMs(run, nowMs)` → ms into the timeline given a run row
  (handles running vs paused vs finished + `paused_accum_ms` + `elapsed_offset_ms`).
- `resolveTimerState(timeline, elapsedMs)` → `{ status, currentStep, segmentRemainingMs,
  segmentElapsedMs, roundIndex, roundCount, nextStep, totalRemainingMs, totalElapsedMs,
  finished }`. The single function the displays call each frame.
- `applySkip(run, timeline, direction, nowMs)` → new `elapsed_offset_ms` (skip to
  next/previous segment boundary). Pure; the API persists the result.

### 2. Migration — `class_timer_templates` + `class_timer_runs`

```
class_timer_templates
  id              uuid pk
  location_id     uuid not null → locations(id) on delete cascade
  name            text not null
  structure       jsonb not null          -- the blocks (see validateStructure)
  total_seconds   int                      -- denormalised buildTimeline().totalMs/1000 for list display
  glofox_program  text                     -- optional: auto-load for this class program/name
  is_active       boolean not null default true
  created_by      uuid → profiles(id)
  created_at / updated_at  timestamptz
  -- location-scoped RLS read; writes service-role (API enforces manager role)

class_timer_runs
  id                uuid pk
  location_id       uuid not null → locations(id) on delete cascade
  template_id       uuid → class_timer_templates(id) on delete set null
  structure_snapshot jsonb not null        -- frozen copy so editing the template can't break a live run
  name              text                    -- snapshot of the template name (+ class name if linked)
  status            text not null           -- 'running' | 'paused' | 'finished' | 'stopped'
  started_at        timestamptz
  paused_at         timestamptz             -- set while paused
  paused_accum_ms   bigint not null default 0
  elapsed_offset_ms bigint not null default 0   -- skip forward/back
  started_by        uuid → profiles(id)
  created_at / updated_at  timestamptz
  -- at most one non-terminal (running|paused) run per location — partial unique index
  -- location-scoped RLS read; service-role writes
```

Partial unique index `... (location_id) WHERE status IN ('running','paused')`
enforces one live timer per location. Starting a new run finalises any existing
live run for that location (status='stopped').

### 3. API routes

- **Templates** (manager-gated, `assertLocationAccess`):
  `GET/POST /api/timer/templates`, `GET/PUT/DELETE /api/timer/templates/[id]`.
  POST/PUT validate via `validateStructure` + recompute `total_seconds`.
- **Runs** (manager-gated): `POST /api/timer/runs` (start — body `{ template_id }`,
  snapshots structure, finalises any live run, inserts running),
  `POST /api/timer/runs/[id]/{pause,resume,skip,stop}` (skip body `{ direction:'next'|'prev' }`).
  `GET /api/timer/active?location_id=` — the location's live run for the control UIs.
- **Public read** (anon, for the TV): the live run state is added to the existing
  `GET /api/public/live/[locationId]` response under `timer` (status,
  structure_snapshot, started_at, paused_at, paused_accum_ms, elapsed_offset_ms,
  server_time already present) — no PII, safe to expose. The TV computes the tick
  from it. (Piggybacking the existing 2s poll = no new polling loop on the TV.)

All run-control routes are thin: load run, apply the pure transition, persist,
return the new state. Idempotency: pause when paused / resume when running are
no-ops.

### 4. Surfaces

- **TV banner** (`/tv/[locationId]/LiveTvClient.jsx`): a top command strip reading
  `data.timer`. Shows: class/template name · current segment label + big countdown
  + an interval progress bar · round X/Y · "next up: <label> <time>" · total
  elapsed / remaining. A local `setInterval(…, 250ms)` ticks the countdown between
  the 2s data polls. Hidden when no live run. The HR leaderboard below is
  unchanged.
- **Web control** (`/studio/timer` or under the existing studio hub): (a) a
  **segment editor** to author/edit templates (add segment / add round-group,
  label, type, seconds; live total), (b) a **control panel** — pick a template
  (or the auto-suggested one for the live class), Start, then Pause/Resume, Skip
  ±, Stop, with the same computed display as the TV so the coach sees what the room
  sees.
- **Mobile control** (staff app, `mobile/app/(tabs)/...` or a studio sub-screen):
  the control panel (not the editor in v1) — pick template, start/pause/skip/stop.
  New `MOBILE_PERMISSIONS` key `timer_control` (+ `DEFAULT_MOBILE_PERMISSIONS_BY_ROLE`).
  JS-only → ships OTA, no native release. Reuses the same `class-timer.js` engine
  (imported from `../../src/lib/class-timer.js` — pure, no web-only deps).

### 5. Optional Glofox-class link

`class_timer_templates.glofox_program` (nullable). The control UIs call the
existing `resolveCurrentOccurrence` (class-occurrences spine); if the live class's
`program`/`name` matches a template's `glofox_program`, that template is
pre-selected ("DR1VE is live — load DR1VE intervals?") for a one-tap start. Purely
a convenience on top of manual pick; no auto-start in v1 (a coach always presses
start).

## Data flow

```
Coach (mobile/web) → POST /api/timer/runs {template_id}
   → snapshot structure, finalise prior live run, insert status=running, started_at=now

Coach → POST /api/timer/runs/[id]/pause|resume|skip|stop
   → pure transition (class-timer.js) → persist new run row

TV  /tv/[locationId]  ──poll 2s──► /api/public/live  → { ...hr, timer: <run state> }
   → resolveTimerState(buildTimeline(snapshot), computeEffectiveElapsedMs(run, server_time))
   → render banner; local 250ms tick smooths the countdown between polls

Control UIs  ──poll 2s──► /api/timer/active  → same compute → same display
```

## Phasing (4 PRs)

- **PR1 — engine + a deployable TV slice.** `class-timer.js` (pure, fully tested) +
  migration + template CRUD API + run-control API + public-read wiring + the **TV
  banner** + a **basic web control** (pick template, start/pause/skip/stop) +
  enough of a template create path to seed one. Outcome: Richard can author a
  simple timer and watch it run on the gym TV — the slice he can judge.
- **PR2 — rich segment editor.** The full template authoring UI (segment + round
  blocks, reorder, types, live total) on web; templates list/manage.
- **PR3 — mobile control.** Staff-app control screen + `timer_control` permission +
  parity. OTA.
- **PR4 — Glofox-class auto-link + polish.** `glofox_program` linking + the
  "this class is live, load its timer?" suggestion; display polish (colours per
  segment type, end-of-class state, sound cue optional).

Each PR: full CI mirror + real `next build`, apply its migration (PR1 only),
`get_advisors`, branch/PR/merge.

## Edge cases & decisions

- **One live timer per location** — enforced by the partial unique index; starting
  a new run stops the old one.
- **Template edited mid-run** — the run uses `structure_snapshot`, immune.
- **Skip past the end** — clamps to `finished`; **skip before start** clamps to 0.
- **Pause across a poll** — `paused_at` + `paused_accum_ms` make the computed
  elapsed exact regardless of when the TV last polled.
- **Clock drift** — displays anchor on the poll's `server_time`, not local `Date.now()`,
  for the base; the local 250ms tick only interpolates between polls.
- **TV reconnect / late join** — state is fully on the server; the next poll
  reconstructs the exact position. No controller-presence dependency.
- **No class running** — the timer is independent of HR; a coach can run a timer
  with zero straps on. The banner shows whenever a run is live, HR or not.
- **Anon exposure** — the public `timer` payload is structure + timestamps only
  (no contact/member data); safe on the public TV route.

## Out of scope (v1)

- Auto-start when a class begins (coach always presses start).
- Per-member timer personalisation / the timer on members' own phones (the member
  app champ-app is separate; this is the in-studio TV + coach control).
- Audio/voice cues on the TV (candidate for PR4 polish, not core).
- Mobile *template authoring* (PR3 ships control only; authoring stays web).
- Realtime transition delivery (polling is the v1 mechanism; realtime is a
  drop-in later if needed).

## Testing

- `class-timer.test.js` — exhaustive pure coverage: `validateStructure`
  (bounds/shapes), `buildTimeline` (round expansion, offsets, totals),
  `computeEffectiveElapsedMs` (running/paused/skip/finished), `resolveTimerState`
  (segment boundaries, round numbering, next-step, totals), `applySkip`
  (next/prev, clamps).
- Run-control routes: transition correctness + the one-live-run invariant
  (DB-mocked).
- Full CI mirror + real `next build` per PR; advisor after PR1's migration.
