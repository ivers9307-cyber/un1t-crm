# Sonos live control on mobile — design

**Date:** 2026-08-22 · **Status:** implemented (SONOSMOB.1-6) · **Ticket prefix:** SONOSMOB
**Depends on:** SONOSLIVE (#1493) + SONOSPLAY (#1494), both merged. Independent of SONOSAPPLY.

## What

The web control strip (`src/components/automations/SonosLiveControl.jsx`),
on the staff mobile app: now-playing readout, previous / play-pause / next,
volume, play a favourite. Nothing else — schedule editing, run-now and the
pause override stay web-only.

## Decisions

### 1. `device_control` becomes a cross-platform key

The three routes the screen calls already gate on the top-level web key:

- `GET  /api/sonos/schedules`   → `hasPermission(user, 'device_control')`
- `GET  /api/sonos/household`   → same
- `GET  /api/sonos/now-playing` → same
- `POST /api/sonos/control`     → same

A separate mobile-namespaced key would let the UI gate and the server gate
disagree in the worst direction (`.mobile.x` ON, web key OFF → a screen where
every call 403s). The repo's rule for this, written on `email_inbox` in
`shared/permissions.js`: *the platform that enforces the key decides which
key it is.* So:

- add `'device_control'` to `CROSS_PLATFORM_KEYS` (`shared/permissions.js`),
  with a comment in the `class_timer` / `email_inbox` style;
- `canMobile(profile, 'device_control', loc)` then resolves through
  `canDashboard` (top-level blob, web defaults) — no change to
  `mobile/lib/permissions.js`;
- delete the `device_control` entry from `WEB_ONLY_OK` in
  `scripts/check-mobile-parity.mjs` (cross-platform keys are matched, not
  exempted — `CROSS_PLATFORM_SET.has(w.key)` short-circuits the check);
- update the `WEB_PERMISSIONS` hint + comment for `device_control` (it
  currently says "Web-only — no mobile counterpart planned").

Role defaults are unchanged: owner + manager ON, head_coach + staff OFF,
master bypasses. The web-side `device_control` comment in SONOS.16 that says
mobile is not planned gets corrected.

### 2. Placement — Studio hub tile → `/sonos`

`mobile/app/(staff)/(tabs)/studio.jsx` gains a fifth `ChoiceCard`:

- icon `musical-notes-outline`, tint `#F59E0B`, title **Studio music**,
  subtitle **Play, pause, volume, favourites**, `router.push('/sonos')`;
- shown when `canMobile(profile, 'device_control', activeLocation)`;
- the hub's "nothing enabled" early return adds `canSonos` to its OR.

`shared/mobile-nav.js`: the `studio` feature's `permKeys` gains
`'device_control'`, so a user holding only music control still gets the
Studio tab. The parity script validates every `permKeys` entry is a
`CROSS_PLATFORM_KEYS` entry or a mobile key with a `webEquivalent` — it is
the former after decision 1.

New screen `mobile/app/(staff)/sonos/index.jsx` (+ `_layout.jsx` mirroring
`ac/_layout.jsx`): permission gate (defence in depth, same copy shape as
`ac/index.jsx`), then a `ScrollView` of one `SonosControlCard` per schedule.

### 3. Scope — live control only, one card per schedule

`mobile/components/SonosControlCard.jsx` renders for one schedule:

- **Readout**: `playbackLabel(state.playbackState)`, then `— track.name` and
  `· track.artist` when present; `state.source` beneath; if
  `metadataFailed`, "Track info couldn't be read" instead of the source line.
- **Transport**: previous, play *or* pause (by `isPlaying`), next.
- **Volume**: see decision 4.
- **Favourites**: a row of chips (one per favourite, `name || id`); tapping
  one sends `load_favorite` with its id. Chips, not a picker — RN has no
  native `<select>`, and a two-deep modal picker is worse than a wrap of
  pills for the handful of favourites a studio keeps.
- **Unavailable states**: `state.success === false` → its `error`;
  `!state.live` → the same `REASON_COPY` map as the web strip
  (`not_configured`, `not_connected`, `refresh_failed`, `db_error`,
  `unreachable`, `no_group`); while the first poll is in flight, a spinner
  with "Checking what's playing…".
- **Failure copy**: a failed action shows the server's `error` under the
  controls; a multi-group partial failure (`applied.length > 0`) shows the
  web strip's amber "Changed on some speakers but not all — check before
  trying again." and never auto-retries (volume_up/down are relative).
- The card never writes to `sonos_schedules` and exposes no schedule edit.

Schedules come from `GET /api/sonos/schedules`, favourites from
`GET /api/sonos/household` (`favorites: [{id, name}]`, plus
`favoritesFailed` → hide the favourites row rather than show an empty one).
Both are fetched once on mount and on focus; the card polls only
`now-playing`.

Empty state (no schedules at the location): "No studio music is set up for
this location yet. Someone with Device control sets it up on the web app
under Marketing → Automations → Studio music." — the `AcDeviceList`
empty-state shape. (Not "An owner": managers hold `device_control` by
default. And "Automations → Sonos" is not a label the web nav has.)

### 4. Volume — step buttons only, no slider

`mobile/package.json` has no slider package, and adding one
(`@react-native-community/slider`) is a native module: a new binary through
both stores and a `runtimeVersion` bump, not an OTA. Not worth it for one
control. The card has **−** / **+** buttons in 5-point steps around a
tabular-nums readout, with the web strip's coalescing: held presses within
250 ms collapse into one relative call, equal ups and downs cancel to zero
and send nothing, the readout moves optimistically and reverts on failure.

When `volumeFailed`: "Volume couldn't be read". When `fixedVolume` (and not
`volumeFailed` — check that first, the flag is meaningless otherwise): "These
speakers are set to a fixed volume". Both hide the buttons.

A slider can ride the next native build if wanted; recorded in Out of scope.

### 5. The playback enum moves to `shared/`

Mobile cannot import `src/lib`, and the pause bug (#1494) was this enum being
guessed in three places. Move `src/lib/sonos/playback.js` →
`shared/sonos-playback.js`; the web file becomes a re-export shim
(`export * from '@shared/sonos-playback'`), the pattern `src/lib/class-timer.js`
uses. The test moves with it to `shared/sonos-playback.test.js` unchanged.

`tests/shared-pair-sync.test.js` pairs modules by shared export NAME across
`shared/**` and `src/lib/**` (cross-named pairs included), but an
`export * from` shim registers as the single name `*`, so the scan would not
fire on this pair. Add a manifest entry anyway — the identity assertion is
the point:

```js
'sonos-playback.js': {
  mode: 'reexport',
  shared: 'shared/sonos-playback.js',
  web: 'src/lib/sonos/playback.js',
  why: '…',
},
```

Entries with explicit `shared`/`web` paths are excluded from the
same-basename census, so the cross-named paths are fine.

`check:mobile-imports` verifies the named imports exist on the shared module.

## Mechanics

### `mobile/lib/sonos-api.js`

Four wrappers, each through `api()` so `authHeaders()` carries the Bearer
token, `x-active-location` and `x-impersonate-target` (a hand-rolled header
drops the last one and breaks "View as user"):

```js
listSonosSchedules(locationId)            // GET  /api/sonos/schedules
getSonosHousehold(locationId)             // GET  /api/sonos/household
getSonosNowPlaying(scheduleId, locationId)// GET  /api/sonos/now-playing?schedule_id=
sendSonosAction(scheduleId, action, value, locationId) // POST /api/sonos/control
```

`api()` returns the server envelope as-is. `now-playing` and `household`
answer `success: true` with `live: false` / `connected: false` + `reason` for
the soft failures, so the card branches on those fields, not on `success`
alone. `control` failures carry `code`, `applied`, `failedGroups` through the
envelope; the card reads `applied` for the partial-failure notice.

### Polling

`now-playing` every 10 s while the screen is focused (`useFocusEffect`),
cleared on blur — 6 requests/min per card against a 1000/min quota. A dropped
poll is swallowed; the next tick recovers. After a successful action the card
re-fetches immediately rather than waiting for the tick.

### OTA

`mobile/app/**`, `mobile/components/**`, `mobile/lib/**` and `shared/**` are
all on the `eas-update.yml` allowlist. **Merging this to `main` publishes an
update group at 100% to every device on the 2.3.0 runtime lane on next
launch.** No native change, so no `runtimeVersion` bump. No new top-level
directory under `mobile/`, so `check:ota-paths` needs nothing.

## Tests

- `shared/sonos-playback.test.js` — the existing test, moved.
- `mobile/lib/sonos-api.test.js` — each wrapper calls `api` with the right
  path, method, `locationId` and body; `value` is omitted from the body when
  undefined (the server's Zod schema has it optional, and `undefined` would
  serialise away anyway — pin that it is not sent as `null`).
- Gates: `check:mobile-parity` (the `WEB_ONLY_OK` removal + `permKeys`
  validation), `check:mobile-imports`, `check:mobile-lint`, `check:ota-paths`,
  `tests/shared-pair-sync.test.js`, `npm test`, `npm run lint`, `npm run build`.
- No device QA from this environment; the screen is verified by lint,
  import-resolution and the wrapper tests. Richard QA's on a phone after the
  OTA lands.

## Out of scope

- A volume slider (native dep → next binary).
- Schedule editing, run-now, pause override on mobile (web-only by design;
  the parity hint says so).
- Push/notification categories — nothing here notifies.
- A pull-to-refresh on the screen (today the favourites-failed hint says leave and come back).
- A "Schedule off" chip on a disabled schedule's card (web renders the same live card; consistent, but a chip would help).
