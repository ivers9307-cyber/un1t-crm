# Home as the physical-location surface — design

**Date:** 2026-08-23
**Status:** Approved by Richard (conversation, 23 Aug) — pending review of this written spec
**Scope:** mobile app only (`mobile/**`). No server routes, no schema, no web changes. OTA-shippable.

## The incident that motivates this

A head coach working at Hatch Street opened the app, changed the studio music, and
nothing happened — twice, with a volume change on the second attempt. The app's
`activeLocation` was still Stillorgan from a previous session, so every command
landed on Stillorgan's speakers, 7km away. Nothing on the Studio music or Smart
plugs screens names the location being controlled; the only hint is small subtitle
text one screen back on the Studio hub, and `activeLocation` is cached across app
launches.

Root cause: the app has ONE location concept — a sticky, global, manually-switched
`activeLocation` — and device control inherits it silently. Device control is
inherently physical: the right location is almost always the building the phone is
standing in.

## Design decision: two location contexts

1. **Working location** — the existing `activeLocation`. What you are
   *administering*: leads, reports, receipts, events, dashboards. Manual switcher
   in More, sticky across sessions. **Completely untouched by this work. Nothing
   ever auto-changes it.**

2. **Physical location** — where the phone is standing, resolved against the
   geofence regions that already ship for staff attendance
   (`/api/attendance/geofence-config`, `mobile/lib/geofence.js`). Device-control
   surfaces key off this. New hook, `usePhysicalLocation()`.

Richard's product framing, which drives the Home redesign: **Home = your physical
work life.** Offsite it answers "when am I next in, and where?"; on-site it
answers "run this studio."

## What changes

### 1. Tab restructure

- Today's Home content — the segmented Today/Studio/Business dashboards in
  `mobile/app/(staff)/(tabs)/index.jsx` — moves intact to a new **Dashboard** tab
  (`dashboard.jsx`). It keeps its permission gating (`dashboard_personal` /
  `dashboard_studio` / `dashboard_business`), `resolveLandingPreference`, segment
  persistence, and pull-to-refresh. This is a file move plus tab wiring, not a
  rewrite.
- The Dashboard tab is visible to anyone holding at least one `dashboard_*`
  permission (same rule that today decides whether Home shows any segments);
  users with none don't get the tab, matching how other tabs gate in
  `(tabs)/_layout.jsx` (`TAB_META` / `bar` / hidden keys).
- **Home** (`index.jsx`) becomes the new physical-location surface described
  below. `notification-nav.js` and any hrefs targeting existing tabs are audited
  in the plan; dashboard-targeted notifications (if any) repoint to the new tab.
- The Studio tab/hub stays as-is in v1. Removing or slimming it is a follow-up
  decision once Home has bedded in.

### 2. `usePhysicalLocation()` — the resolver

Returns `{ status, location }` where `status` is `loading` during resolution,
then one of:

- `at_studio` — the phone's position falls inside exactly one configured geofence
  region belonging to a location in the user's `locations` list. `location` is
  that location object (so `canMobile(profile, feature, location)` works
  directly).
- `offsite` — position resolved, inside no configured region.
- `unknown` — location permission denied, position unavailable, geofence config
  empty/unfetchable, or resolution timed out.

Rules:

- **Resolve on focus/foreground only, never live.** A position read runs when
  Home (or a device-control screen) gains focus or the app foregrounds (a
  45-second module-level position cache absorbs rapid screen-hopping — Home →
  Sonos → Home fires one GPS acquisition, not three; well inside the 5-minute
  staleness gate, so the morning-Stillorgan/afternoon-Hatch trap is
  unaffected). The resolved verdict is then FROZEN for that screen visit — a GPS wobble or a genuine
  walk-out must not swap which studio a thumb is about to command mid-screen.
  The last geofence ENTER event may serve as a fast path to paint immediately,
  but a fresh read confirms it: a coach at Stillorgan in the morning and Hatch
  in the afternoon must not inherit the morning's region.
- Regions come from the same config the attendance feature syncs; the hook does
  not register OS geofences itself and works even if background geofencing was
  never granted — it only needs foreground position ("while using the app").
  Attendance's background permission is neither required nor requested by this
  feature.
- Overlapping regions (should not exist at 7km spacing, but defensively): treat
  as `unknown` rather than guessing.
- Stillorgan/Hatch spacing makes accuracy a non-issue; no accuracy-radius logic
  in v1 beyond what the point-in-region check needs.
- Impersonation ("View as user"): physical resolution uses the real device's
  position; permissions/feature filtering use the impersonated profile, same as
  every other screen.

### 3. New Home — three states

**State A: on-site (`at_studio`)**

- Header: the studio name, large — the anchor of the screen — with a
  "detected" pill.
- Control tiles for that studio, filtered by `canMobile` per feature *at that
  location*: Studio music, Smart plugs, Doors, AC, Class timer, TV displays.
  Tiles route to the existing screens (see §4). A feature the location doesn't
  have or the user can't use at it simply doesn't render (same philosophy as
  the Studio hub today).
- Below the tiles: **today's roster at this studio** — the location's shift
  blocks for today via the existing `GET /api/schedule/shifts` (the
  `getTeamShifts` shape, which embeds names server-side).

**State B: offsite (`offsite`, and also `unknown`)**

- **Your assigned shifts across ALL your studios for the next 7 days.** Data:
  ONE `getMyShifts({ profileId, startDate, endDate })` call with no
  `location_id` — the route fans out to every location the caller is assigned
  to (see Data flow), so there is no per-location call and no client-side
  merge. Each shift row is badged with its studio using
  `shared/location-colors.js`. Effective times follow the existing
  override-aware resolution in `mobile/lib/schedule-team.js`.
- Empty state (no shifts in the window — owners, un-rostered staff): "No shifts
  this week" line, never a blank screen; the remote-controls entry (below) still
  renders.
- **Demoted remote-controls entry**: a compact "Studio controls" row under the
  shift list. Tapping it presents a manual location pick from the user's
  `device_control`-permitted locations, then routes to that location's controls
  clearly labelled "manual" (§4). This preserves the legitimate
  manager-at-home use while making remote control impossible to stumble into.
- `unknown` renders identically to `offsite` — the shift list needs no location
  permission at all, so a permission-denied user gets a fully useful Home, not
  a degraded one. No nagging permission prompt on Home; if the OS permission is
  denied the on-site flip simply never happens.

**State C: loading** — brief spinner/skeleton while the first resolution + shift
fetch run; cached last-known shifts may paint immediately with a refresh
underneath (matching existing screen conventions: a transport blip keeps the
last painted state — the `transport: true` envelope rule from SONOSMOB.4c).

### 4. Device-control screens — the pill and the override

Sonos (`(staff)/sonos/`), Shelly (`(staff)/shelly/`), Doors, and AC screens
change their `locationId` source from `activeLocation` to a shared resolution:

```
controlLocation = explicit override (this visit)
               ?? physical location (when at_studio)
               ?? activeLocation
```

- Every one of these screens renders a **location pill** at the top:
  "Hatch Street · detected" (at_studio) or "Stillorgan · manual" (fallback or
  override) — visually distinct states, always present, tappable.
- Tapping the pill opens the manual location pick (locations where the user
  holds `device_control`). The override lasts **for that screen visit only** —
  it is not persisted; the next visit re-resolves from scratch.
- The override and the Home manual entry never touch `activeLocation`.
- These screens already pass `locationId` explicitly on every API call
  (`sonos-api.js`, `shelly.js` wire layers) and already handle a mid-screen
  `locationId` change (spinner, not stale cards — the `listLocationRef`
  pattern). The server enforces `device_control` per location on every route,
  so a wrong client-side resolution cannot escalate access.

### 5. Guardrails (restating the invariants)

- `activeLocation` is never written by any of this. No auto-switch of the
  working location, ever.
- Control commands are always sent with an explicit `locationId`; the screen
  showing the pill and the call carrying the id derive from the SAME resolved
  value, so what you see is what you command.
- Physical resolution is a UI convenience, not an authorization input — the
  server's per-location permission checks remain the boundary.
- Resolution is frozen per screen visit (§2); no live flips.

## Data flow summary

- Geofence regions: `GET /api/attendance/geofence-config` — **amended during
  planning**: the route filters `geofence_exempt` assignments out of `regions`
  (correct for attendance), so an exempt staffer would get zero regions and the
  on-site flip would never fire for them. The route gains one additive field,
  `all_regions` — the same region shape for ALL the caller's assigned
  locations, ignoring exemption. Attendance behaviour (`regions`, `required`,
  `gate_copy`) is unchanged; the hook reads `all_regions ?? regions`.
- My shifts: `GET /api/schedule/shifts?profile_id&start_date&end_date` —
  **amended during planning**: the route already falls back to ALL the
  caller's locations when `location_id` is omitted, and rows embed
  `locations(name)`. Cross-studio shifts are ONE call; no client-side
  per-location merge is needed.
- Today's roster: same route with `location_id` + no `profile_id` (existing).
- Controls: existing `/api/sonos/*`, `/api/shelly/*`, doors, AC routes — only
  the `locationId` the mobile screens pass changes provenance.
- No schema changes. The only server change is the additive `all_regions`
  field above.

## Manual override mechanics (settled during planning)

- The per-visit override rides an expo-router `loc` search param on the four
  control screens; the pill's picker calls `router.setParams({ loc })`. Stack
  params die on pop, which gives per-visit semantics for free.
- Home's offsite "Studio controls" entry opens a picker over the caller's
  `device_control` locations, then pushes a small launcher stack screen
  (`(staff)/controls`) that renders the same tile list for the picked
  location, labelled manual, forwarding `?loc=` to each control screen. The
  Studio hub stays untouched, as scoped.

## Error handling

- The shift fetch is ONE cross-studio call, so there is no per-studio failure
  to report: a failure raises a single banner rendered ABOVE the list rather
  than replacing it — once a good list has been painted, a later failure means
  "this may be stale", not "you have no shifts". Only a failure with nothing
  painted yet owns the whole space.
- All fetches ride `api()`; `transport: true` envelopes keep last painted state
  (existing convention).
- Geofence-config or position failures degrade to `unknown` → offsite layout.
  Never an error state for a location-permission problem.

## Testing

Follows the mobile codebase's pure-logic pattern (`*-logic.js` + Jest, no
device dependency):

- Resolver logic (point-in-region, single/overlapping/none, permission-denied,
  stale-ENTER-vs-fresh-read precedence) as a pure module with the position and
  config injected; the hook is a thin wrapper.
- Home state machine: at_studio/offsite/unknown/loading rendering decisions,
  the 7-day window + per-day grouping/sort of the one fan-out call's rows,
  empty states, fetch failure (one banner, list retained).
- Control-location resolution order (override ?? physical ?? active) and
  per-visit override reset.
- Tab gating: Dashboard tab visibility per permission combinations.
- No local device QA is possible (no local DB — CLAUDE.md); phone QA happens
  post-OTA like Sonos/Shelly mobile did. `next build` + full suite + the OTA
  export check gate the merge as usual.

## Out of scope (explicit)

- Removing/slimming the Studio tab (follow-up decision).
- Auto-switching `activeLocation` (rejected: creates the mirror-image bug for
  admin work).
- Time-off display on Home, shift detail/swap actions from Home (Schedule tab
  already owns those), badges/counts on tiles.
- Any change to attendance geofencing behaviour or its permission prompts.
- Server-side anything.

## Rollout

Pure `mobile/**` (+ possibly `shared/` reads) → ships as an OTA on the 2.3.0
public lane on merge. **OTA trap applies: a partial rollout blocks the next
publish — default 100%.** No `runtimeVersion` bump needed: `expo-location` is
already a native dependency via the attendance feature; the plan must verify no
new native module is introduced (if one ever is, the runtime bump rule from the
Face ID release applies).
