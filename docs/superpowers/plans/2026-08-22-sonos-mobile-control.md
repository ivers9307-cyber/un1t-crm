# Sonos live control on mobile — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The web Sonos control strip (now-playing, transport, volume, favourites) on the staff mobile app, reached from a Studio-hub tile, gated by the same `device_control` key the API routes already enforce.

**Architecture:** No new server code. `device_control` joins `CROSS_PLATFORM_KEYS` so `canMobile` resolves it from the top-level blob; a `mobile/lib/sonos-api.js` wraps the four existing `/api/sonos/*` routes through `api()`; `mobile/components/SonosControlCard.jsx` renders one schedule's controls and polls `now-playing` while focused; `mobile/app/(staff)/sonos/` is the screen. The playback enum moves to `shared/sonos-playback.js` so both platforms read one implementation.

**Tech Stack:** Expo / React Native (expo-router, nativewind, `@expo/vector-icons`), vitest for `mobile/lib` + `shared/`. Spec: `docs/superpowers/specs/2026-08-22-sonos-mobile-control-design.md`.

**Repo rules that bite here** (from `CLAUDE.md`):
- Mobile CANNOT import `src/lib`. Shared code lives in `shared/` and is imported as the bare package `'shared/<module>'` — never a relative `../shared`.
- Every mobile `/api/*` call goes through `api()` / `authHeaders()` from `mobile/lib/api.js` — a hand-rolled `Bearer` header drops `x-impersonate-target` and breaks "View as user".
- `check:mobile-parity`, `check:mobile-imports`, `check:mobile-lint` (`--max-warnings 0`, ERROR-level) and `check:ota-paths` all gate this.
- `un1t-*` design tokens only (`bg-un1t-bg`, `bg-un1t-surface`, `border-un1t-border`, `text-un1t-text`, `text-un1t-subtle`, `text-un1t-muted`). Status text on light cards: `text-<c>-700`, never -300/-400.
- **Merging to `main` publishes an OTA at 100% to every phone on the 2.3.0 lane.** That is the intended route for this change; no `runtimeVersion` bump (no native change).
- Ticket prefix for commits: `SONOSMOB.N — summary`. Run everything from the worktree root. Never `git stash`.
- `mobile/lib/*.test.js` and `shared/*.test.js` run under the root vitest (`npm test`); `mobile/lib` tests must `vi.mock('./api')` BEFORE importing the module under test, or the RN runtime loads under Node and explodes.

---

### Task 1: Move the playback enum to `shared/`

**Files:**
- Create: `shared/sonos-playback.js` (moved from `src/lib/sonos/playback.js`)
- Create: `shared/sonos-playback.test.js` (moved from `src/lib/sonos/playback.test.js`)
- Modify: `src/lib/sonos/playback.js` → becomes a re-export shim
- Delete: `src/lib/sonos/playback.test.js`
- Modify: `tests/shared-pair-sync.test.js:104-120` (manifest entry)

- [ ] **Step 1: Move the implementation and its test with git**

```bash
git mv src/lib/sonos/playback.js shared/sonos-playback.js
git mv src/lib/sonos/playback.test.js shared/sonos-playback.test.js
```

- [ ] **Step 2: Fix the test's import path**

In `shared/sonos-playback.test.js`, change

```js
} from './playback'
```

to

```js
} from './sonos-playback'
```

- [ ] **Step 3: Add a line to the moved module's header**

In `shared/sonos-playback.js`, append to the header comment (after the line ending `cannot re-derive them wrong.`):

```js
//
// SONOSMOB.1 — moved from src/lib/sonos/playback.js to shared/ so the mobile
// control card can import it (mobile cannot reach src/lib). The web path is
// a re-export shim; tests/shared-pair-sync.test.js proves by identity that
// both sides are this one implementation.
```

- [ ] **Step 4: Write the web shim**

Create `src/lib/sonos/playback.js`:

```js
// SONOSMOB.1 — the playback enum moved to shared/sonos-playback.js so the
// mobile control card can read it (mobile cannot import src/lib). This shim
// keeps every web import of `@/lib/sonos/playback` working unchanged. The
// implementation + its test live in shared/; tests/shared-pair-sync.test.js
// asserts the two paths resolve to the SAME objects.
export * from '@shared/sonos-playback'
```

- [ ] **Step 5: Register the pair in the sync manifest**

In `tests/shared-pair-sync.test.js`, inside `const PAIRS = {` under the `// ── reexport` heading, after the `'race-control.js'` entry (which ends `why: 'Pure timing helpers live in shared/; the one IO helper (ensureTeamForBooking) stays web-only in src/lib.',\n  },`), add:

```js
  'sonos-playback.js': {
    mode: 'reexport',
    shared: 'shared/sonos-playback.js',
    web: 'src/lib/sonos/playback.js',
    why:
      'SONOSMOB.1 moved the Sonos playbackState enum + isPlaying/playbackLabel to shared/ for the mobile control ' +
      'card; the web path is an `export * from` shim. Cross-named (sonos/playback.js vs sonos-playback.js), so the ' +
      'export-name scan would not pair them on its own — this entry is what makes the identity assertion run.',
  },
```

- [ ] **Step 6: Run the moved test, the pair-sync test, and the web consumers' lint**

Run: `npx vitest run shared/sonos-playback.test.js tests/shared-pair-sync.test.js`
Expected: all pass, including a new `sonos-playback.js: every shared export is the SAME object on the web side`.

Run: `npx eslint src/components/automations/SonosLiveControl.jsx src/components/automations/SonosScheduleClient.jsx src/lib/sonos/playback.js`
Expected: clean (both components import from `@/lib/sonos/playback`, which still resolves).

- [ ] **Step 7: Commit**

```bash
git add shared/sonos-playback.js shared/sonos-playback.test.js src/lib/sonos/playback.js tests/shared-pair-sync.test.js
git commit -m "SONOSMOB.1 — playback enum moves to shared/ (web path is a re-export shim)" -m "The pause bug was this enum guessed in three places. Mobile cannot import src/lib, so the one implementation now lives in shared/sonos-playback.js; pair-sync proves identity."
```

---

### Task 2: `device_control` becomes cross-platform

**Files:**
- Modify: `shared/permissions.js:113-121` (hint + comment), `:1088-1095` (`CROSS_PLATFORM_KEYS`)
- Modify: `scripts/check-mobile-parity.mjs:197-202` (delete the `WEB_ONLY_OK` entry)
- Modify: `shared/mobile-nav.js:28` (`studio` permKeys)

- [ ] **Step 1: Run the parity check to see the baseline**

Run: `npm run check:mobile-parity`
Expected: exits 0 (clean before the change).

- [ ] **Step 2: Add the key to `CROSS_PLATFORM_KEYS`**

In `shared/permissions.js`, replace

```js
  'email_inbox',
])
```

(the close of `CROSS_PLATFORM_KEYS`, immediately after the `email_mailbox_access grant, on both platforms.` comment line) with

```js
  'email_inbox',
  // SONOSMOB.2 — live control of the studio Sonos (now-playing, transport,
  // volume, favourites) on mobile rides the SAME /api/sonos/* routes the
  // web strip calls, and every one of those gates on the top-level
  // `device_control` key. Same reasoning as `email_inbox` above: the
  // platform that enforces the key decides which key it is, or the UI
  // gate and the server gate can disagree. Scheduling (windows, run-now,
  // the pause override) stays web-only; the mobile screen is control only.
  'device_control',
])
```

- [ ] **Step 3: Correct the `WEB_PERMISSIONS` entry**

In `shared/permissions.js`, replace

```js
  // SONOS.16 — device_control now gates Sonos studio-music scheduling;
  // its old surface (Tapo plug/switch control, TAPO-T1.4) was deleted at
  // SONOS.14. Per-schedule playback windows (days/on/off/volume/
  // favourite), manual run-now, and a temporary pause override, live at
  // /automations/sonos. Web-only — no mobile counterpart planned (see
  // WEB_ONLY_OK in scripts/check-mobile-parity.mjs). Owner + manager by
  // default; head_coach + staff off (on-site operations oversight).
  { key: 'device_control', label: 'Device control',
    hint: 'Sonos speakers: playback schedules, run-now, temporary pause.' },
```

with

```js
  // SONOS.16 — device_control now gates Sonos studio-music scheduling;
  // its old surface (Tapo plug/switch control, TAPO-T1.4) was deleted at
  // SONOS.14. Per-schedule playback windows (days/on/off/volume/
  // favourite), manual run-now, and a temporary pause override, live at
  // /automations/sonos (web). SONOSMOB.2 made the key cross-platform
  // (CROSS_PLATFORM_KEYS): the mobile Studio hub's "Studio music" screen
  // offers live control only — play/pause/skip, volume, favourites — over
  // the same /api/sonos/* routes. Owner + manager by default; head_coach +
  // staff off (on-site operations oversight).
  { key: 'device_control', label: 'Device control',
    hint: 'Sonos speakers: playback schedules, run-now and temporary pause on web; live play/pause, volume and favourites on web and mobile.' },
```

- [ ] **Step 4: Delete the stale `WEB_ONLY_OK` entry**

In `scripts/check-mobile-parity.mjs`, delete these six lines entirely:

```js
  // SONOS.16 — Sonos studio-music scheduling (playback windows: days,
  // times, volume, favourite; run-now; a temporary pause) at
  // /automations/sonos, replacing the deleted Tapo plug/switch path
  // (TAPO-T1.4). Desktop setup surface, same shape as
  // glofox_import/landing_page; no mobile counterpart planned.
  device_control: 'Sonos studio-music scheduling at /automations/sonos (replaces the deleted Tapo plug/switch path, TAPO-T1.4) — desktop setup surface, no mobile counterpart planned.',
```

(The `WEB_ONLY_OK` lookup runs BEFORE the `CROSS_PLATFORM_SET` check in the drift loop, so a leftover entry would silently mask rather than fail — delete it, don't leave it.)

- [ ] **Step 5: Let the Studio tab light up for music-only users**

In `shared/mobile-nav.js`, replace

```js
  { key: 'studio',   label: 'Studio',    permKeys: ['studio_management', 'class_timer', 'tv_displays'], barEligible: true },
```

with

```js
  // SONOSMOB.2 — device_control added: a user holding only live music
  // control still needs the Studio hub to reach /sonos.
  { key: 'studio',   label: 'Studio',    permKeys: ['studio_management', 'class_timer', 'tv_displays', 'device_control'], barEligible: true },
```

- [ ] **Step 6: Run the gates that read these files**

Run: `npm run check:mobile-parity && npx vitest run shared/permissions shared/mobile-nav.test.js mobile/lib/permissions`
Expected: parity exits 0 (no `webDrift` for `device_control`; `MOBILE_NAV_FEATURES` permKey validation accepts `device_control` as a `CROSS_PLATFORM_KEYS` entry); tests pass.

- [ ] **Step 7: Commit**

```bash
git add shared/permissions.js scripts/check-mobile-parity.mjs shared/mobile-nav.js
git commit -m "SONOSMOB.2 — device_control is cross-platform" -m "The /api/sonos/* routes already enforce the top-level key; a mobile-namespaced twin could be ON while the web key is OFF and render a screen where every call 403s. Same rule as email_inbox."
```

---

### Task 3: `mobile/lib/sonos-api.js` — the wire layer, test-first

**Files:**
- Create: `mobile/lib/sonos-api.js`
- Create: `mobile/lib/sonos-api.test.js`

- [ ] **Step 1: Write the failing test**

```js
// mobile/lib/sonos-api.test.js
// `./api` is mocked BEFORE import: it pulls the React-Native runtime, which
// must never load under vitest's Node environment.
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('./api', () => ({ api: vi.fn() }))

import { api } from './api'
import {
  listSonosSchedules,
  getSonosHousehold,
  getSonosNowPlaying,
  sendSonosAction,
} from './sonos-api'

beforeEach(() => {
  vi.clearAllMocks()
  api.mockResolvedValue({ success: true })
})

describe('listSonosSchedules', () => {
  it('GETs the schedules list for the location', async () => {
    await listSonosSchedules('loc-1')
    expect(api).toHaveBeenCalledWith('/api/sonos/schedules', { locationId: 'loc-1' })
  })
})

describe('getSonosHousehold', () => {
  it('GETs the household (favourites live there)', async () => {
    await getSonosHousehold('loc-1')
    expect(api).toHaveBeenCalledWith('/api/sonos/household', { locationId: 'loc-1' })
  })
})

describe('getSonosNowPlaying', () => {
  it('GETs now-playing with the schedule id as a query param', async () => {
    await getSonosNowPlaying('11111111-1111-1111-1111-111111111111', 'loc-1')
    expect(api).toHaveBeenCalledWith(
      '/api/sonos/now-playing?schedule_id=11111111-1111-1111-1111-111111111111',
      { locationId: 'loc-1' },
    )
  })

  it('URL-encodes the schedule id rather than trusting it', async () => {
    await getSonosNowPlaying('a b&c', 'loc-1')
    expect(api.mock.calls[0][0]).toBe('/api/sonos/now-playing?schedule_id=a%20b%26c')
  })
})

describe('sendSonosAction', () => {
  it('POSTs the action with a value', async () => {
    await sendSonosAction('s1', 'set_volume', 40, 'loc-1')
    expect(api).toHaveBeenCalledWith('/api/sonos/control', {
      method: 'POST',
      locationId: 'loc-1',
      body: { schedule_id: 's1', action: 'set_volume', value: 40 },
    })
  })

  it('omits `value` entirely when there is none — not null, not undefined', async () => {
    // The route's Zod schema has value optional; a null would fail
    // z.union([number, string]) and turn every play/pause into a 400.
    await sendSonosAction('s1', 'pause', undefined, 'loc-1')
    const body = api.mock.calls[0][1].body
    expect(body).toEqual({ schedule_id: 's1', action: 'pause' })
    expect('value' in body).toBe(false)
  })

  it('returns the server envelope as-is so the card can read code/applied/failedGroups', async () => {
    api.mockResolvedValue({ success: false, error: 'nope', code: 'failed', applied: ['G1'], failedGroups: ['G2'] })
    const r = await sendSonosAction('s1', 'volume_up', 5, 'loc-1')
    expect(r).toEqual({ success: false, error: 'nope', code: 'failed', applied: ['G1'], failedGroups: ['G2'] })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run mobile/lib/sonos-api.test.js`
Expected: FAIL — `Failed to resolve import "./sonos-api"`.

- [ ] **Step 3: Write the implementation**

```js
// mobile/lib/sonos-api.js
// SONOSMOB.3 — mobile wire layer for the Sonos live-control screen.
//
// Four calls, all onto routes the web control strip already uses. Every one
// goes through api() so authHeaders() carries the Bearer token,
// x-active-location AND x-impersonate-target — a hand-rolled header drops
// the last one and "View as user" silently runs as the real master.
//
// Those routes are service-role (no RLS) and gate on the top-level
// `device_control` key — cross-platform since SONOSMOB.2, so the screen
// gates on the same key via canMobile and the UI never offers something
// the server refuses.
//
// Soft failures come back as success: true with live: false / connected:
// false + a `reason` (now-playing, household). Branch on those fields, not
// on .success alone. Control failures carry `code`, and on a multi-group
// schedule `applied` / `failedGroups` — volume_up/down are RELATIVE, so a
// partial failure must never be blindly retried.

import { api } from './api'

export function listSonosSchedules(locationId) {
  return api('/api/sonos/schedules', { locationId })
}

// Favourites live on the household response: { connected, reachable,
// favorites: [{ id, name }], favoritesFailed? }.
export function getSonosHousehold(locationId) {
  return api('/api/sonos/household', { locationId })
}

export function getSonosNowPlaying(scheduleId, locationId) {
  return api(`/api/sonos/now-playing?schedule_id=${encodeURIComponent(scheduleId)}`, { locationId })
}

// `value` is omitted from the body when undefined. The route's Zod schema
// makes it optional; a null would fail z.union([number, string]).
export function sendSonosAction(scheduleId, action, value, locationId) {
  const body = { schedule_id: scheduleId, action }
  if (value !== undefined) body.value = value
  return api('/api/sonos/control', { method: 'POST', locationId, body })
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run mobile/lib/sonos-api.test.js`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add mobile/lib/sonos-api.js mobile/lib/sonos-api.test.js
git commit -m "SONOSMOB.3 — mobile wire layer for /api/sonos/*" -m "Through api() so View-as-user keeps working; value omitted (not null) when absent."
```

---

### Task 4: `SonosControlCard` — one schedule's controls

**Files:**
- Create: `mobile/components/SonosControlCard.jsx`

No unit test: it is a React Native component and the mobile tree has no RN test renderer. It is verified by `check:mobile-lint`, `check:mobile-imports` (the `shared/sonos-playback` names), and device QA after the OTA.

- [ ] **Step 1: Write the component**

```jsx
// mobile/components/SonosControlCard.jsx
// SONOSMOB.4 — live control for ONE Sonos schedule: the mobile twin of
// src/components/automations/SonosLiveControl.jsx. Read that file's header
// before changing this one — the now-playing response shape is matched
// exactly, not guessed.
//
// This is for one-off "nudge it right now" actions. It never writes to
// sonos_schedules and exposes no schedule editing — a change made here
// persists until the schedule's next window boundary, the same as a change
// made from the Sonos app itself.
//
// Volume is step buttons, not a slider: the app has no slider package and
// adding one is a native module (new binary through the stores, not an OTA).

import { useState, useEffect, useCallback, useRef } from 'react'
import { View, Text, Pressable, ActivityIndicator } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useFocusEffect } from 'expo-router'
import { isPlaying, playbackLabel } from 'shared/sonos-playback'
import { getSonosNowPlaying, sendSonosAction } from '../lib/sonos-api'

const POLL_MS = 10_000
const VOLUME_STEP = 5
const DEBOUNCE_MS = 250

// Same copy as the web strip's REASON_COPY — keep them in step.
const REASON_COPY = {
  not_configured: "Sonos isn't configured on this deploy.",
  not_connected: 'Sonos is not connected.',
  refresh_failed: "Sonos didn't accept the stored connection — reconnect on the web app.",
  db_error: 'Something went wrong reading the connection.',
  unreachable: 'Sonos is not answering right now.',
  no_group: "None of this schedule's speakers are online.",
}

// Polls now-playing every POLL_MS while the screen is focused; stops on
// blur. A dropped poll is not worth surfacing — the next tick recovers.
function useNowPlaying(scheduleId, locationId) {
  const [state, setState] = useState(null)
  const load = useCallback(async () => {
    const r = await getSonosNowPlaying(scheduleId, locationId)
    setState(r)
  }, [scheduleId, locationId])

  useFocusEffect(useCallback(() => {
    load()
    const timer = setInterval(load, POLL_MS)
    return () => clearInterval(timer)
  }, [load]))

  return [state, load]
}

// Coalesces held +/- presses into one relative call. Math.abs is
// deliberate — direction lives in the action name (volume_up/volume_down),
// and the server reads a negative step as a size. Equal ups and downs
// cancel to 0 and send nothing.
function useVolumeNudge(send) {
  const pending = useRef(0)
  const timer = useRef(null)

  return useCallback((direction) => {
    pending.current += direction === 'up' ? VOLUME_STEP : -VOLUME_STEP
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      const total = pending.current
      pending.current = 0
      timer.current = null
      if (!total) return
      send(total > 0 ? 'volume_up' : 'volume_down', Math.abs(total))
    }, DEBOUNCE_MS)
  }, [send])
}

function IconButton({ icon, label, onPress, disabled }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      className="h-11 w-11 rounded-full border border-un1t-border items-center justify-center active:opacity-70"
      style={disabled ? { opacity: 0.4 } : null}
    >
      <Ionicons name={icon} size={20} color="#111827" />
    </Pressable>
  )
}

export default function SonosControlCard({ schedule, favorites, locationId }) {
  const [state, reload] = useNowPlaying(schedule.id, locationId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [partialFailure, setPartialFailure] = useState(false)
  // Optimistic volume while nudging, reverted on failure. Null means "show
  // the server's reported volume".
  const [pendingVolume, setPendingVolume] = useState(null)

  // Fresh server data replaces any stale optimistic value.
  useEffect(() => { setPendingVolume(null) }, [state?.volume])

  const send = useCallback(async (action, value) => {
    setBusy(true); setError(null); setPartialFailure(false)
    const r = await sendSonosAction(schedule.id, action, value, locationId)
    if (!r.success) {
      // volume_up/volume_down are relative — an `applied` list means some
      // groups already moved, so retrying the whole action would
      // double-apply it there. Say so instead of auto-retrying. On the
      // common single-group setup a failure comes back with applied: [],
      // so the plain error below is the accurate message.
      if (r.applied?.length > 0) setPartialFailure(true)
      setPendingVolume(null)
      setError(r.error || 'That did not work')
    } else {
      await reload()
    }
    setBusy(false)
  }, [schedule.id, locationId, reload])

  const nudgeVolume = useVolumeNudge((action, step) => {
    const base = pendingVolume ?? state?.volume ?? 0
    const next = action === 'volume_up' ? Math.min(100, base + step) : Math.max(0, base - step)
    setPendingVolume(next)
    send(action, step)
  })

  return (
    <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-4">
      <Text className="text-base font-semibold text-un1t-text">{schedule.name || 'Studio music'}</Text>

      {!state ? (
        <View className="flex-row items-center mt-2">
          <ActivityIndicator color="#94A3B8" />
          <Text className="text-xs text-un1t-subtle ml-2">Checking what&apos;s playing…</Text>
        </View>
      ) : state.success === false || !state.live ? (
        <Text className="text-sm text-un1t-subtle mt-2">
          {state.success === false
            ? (state.error || 'Something went wrong.')
            : (REASON_COPY[state.reason] || "Live control isn't available right now.")}
        </Text>
      ) : (
        <LiveControls
          state={state}
          favorites={favorites}
          busy={busy}
          pendingVolume={pendingVolume}
          onSend={send}
          onNudge={nudgeVolume}
        />
      )}

      {partialFailure && (
        <View className="flex-row items-start mt-3">
          <Ionicons name="alert-circle-outline" size={14} color="#B45309" style={{ marginTop: 2 }} />
          <Text className="text-xs text-amber-700 ml-1.5 flex-1">
            Changed on some speakers but not all — check before trying again.
          </Text>
        </View>
      )}
      {error && !partialFailure && (
        <Text className="text-xs text-red-700 mt-3">{error}</Text>
      )}
    </View>
  )
}

function LiveControls({ state, favorites, busy, pendingVolume, onSend, onNudge }) {
  const volumeUnreadable = state.volumeFailed
  // fixedVolume only means something when the volume read succeeded —
  // check volumeFailed first.
  const volumeFixed = !state.volumeFailed && state.fixedVolume
  const shownVolume = pendingVolume ?? state.volume ?? 0

  return (
    <View>
      {/* Readout */}
      <Text className="text-sm text-un1t-text mt-1">
        {playbackLabel(state.playbackState)}
        {state.track?.name ? ` — ${state.track.name}` : ''}
        {state.track?.artist ? <Text className="text-un1t-subtle"> · {state.track.artist}</Text> : null}
      </Text>
      {state.metadataFailed ? (
        // A failed metadata read looks identical to "nothing playing" —
        // both leave track/source null. Say so; the controls still work.
        <Text className="text-xs text-un1t-subtle">Track info couldn&apos;t be read</Text>
      ) : state.source ? (
        <Text className="text-xs text-un1t-subtle">{state.source}</Text>
      ) : null}

      {/* Transport */}
      <View className="flex-row items-center justify-center gap-4 mt-4">
        <IconButton icon="play-skip-back" label="Previous" onPress={() => onSend('skip_previous')} disabled={busy} />
        {isPlaying(state.playbackState) ? (
          <IconButton icon="pause" label="Pause" onPress={() => onSend('pause')} disabled={busy} />
        ) : (
          <IconButton icon="play" label="Play" onPress={() => onSend('play')} disabled={busy} />
        )}
        <IconButton icon="play-skip-forward" label="Next" onPress={() => onSend('skip_next')} disabled={busy} />
      </View>

      {/* Volume */}
      <View className="flex-row items-center justify-center mt-4">
        {volumeUnreadable ? (
          <View className="flex-row items-center">
            <Ionicons name="volume-mute-outline" size={16} color="#94A3B8" />
            <Text className="text-xs text-un1t-subtle ml-1.5">Volume couldn&apos;t be read</Text>
          </View>
        ) : volumeFixed ? (
          <View className="flex-row items-center">
            <Ionicons name="volume-medium-outline" size={16} color="#94A3B8" />
            <Text className="text-xs text-un1t-subtle ml-1.5">These speakers are set to a fixed volume</Text>
          </View>
        ) : (
          <View className="flex-row items-center gap-4">
            <IconButton icon="remove" label="Volume down" onPress={() => onNudge('down')} disabled={busy} />
            <View className="flex-row items-center w-16 justify-center">
              <Ionicons name="volume-medium-outline" size={16} color="#94A3B8" />
              <Text className="text-base text-un1t-text ml-1.5 tabular-nums">{shownVolume}</Text>
            </View>
            <IconButton icon="add" label="Volume up" onPress={() => onNudge('up')} disabled={busy} />
          </View>
        )}
      </View>

      {/* Favourites — chips, not a picker: RN has no native <select>, and a
          two-deep modal is worse than a wrap of pills for a studio's handful. */}
      {favorites.length > 0 && (
        <View className="mt-4">
          <Text className="text-[11px] uppercase tracking-wider text-un1t-subtle mb-2">Play favourite</Text>
          <View className="flex-row flex-wrap gap-2">
            {favorites.map((f) => (
              <Pressable
                key={f.id}
                onPress={() => onSend('load_favorite', f.id)}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel={`Play ${f.name || f.id}`}
                className="px-3 py-1.5 rounded-full border border-un1t-border bg-un1t-bg active:opacity-70"
                style={busy ? { opacity: 0.4 } : null}
              >
                <Text className="text-sm text-un1t-text">{f.name || f.id}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      )}
    </View>
  )
}
```

- [ ] **Step 2: Lint it**

Run: `npm run check:mobile-lint && npm run check:mobile-imports`
Expected: both exit 0. (`react-hooks/exhaustive-deps` is ERROR-level in the mobile config — every `useCallback`/`useEffect` above lists its deps.)

- [ ] **Step 3: Commit**

```bash
git add mobile/components/SonosControlCard.jsx
git commit -m "SONOSMOB.4 — SonosControlCard: one schedule's live controls" -m "Mobile twin of SonosLiveControl. Step-button volume (a slider is a native dep), favourite chips, partial-failure notice, no auto-retry on relative volume."
```

---

### Task 5: The `/sonos` screen and the Studio-hub tile

**Files:**
- Create: `mobile/app/(staff)/sonos/_layout.jsx`
- Create: `mobile/app/(staff)/sonos/index.jsx`
- Modify: `mobile/app/(staff)/(tabs)/studio.jsx:1-15,47-60,66-100`

- [ ] **Step 1: The stack layout**

Create `mobile/app/(staff)/sonos/_layout.jsx`:

```jsx
// SONOSMOB.5 — Studio music stack.
//
// Lives outside (tabs) so the bottom tab bar hides on this screen — it is
// reached from the Studio hub, not as a primary tab (same shape as ac/).

import { Stack } from 'expo-router'
import BackHeaderLeft from '../../../components/BackHeaderLeft'

export default function SonosLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#FFFFFF' },
        headerTitleStyle: { fontWeight: '600' },
        headerTintColor: '#111827',
      }}
    >
      {/* Pushed from the Studio hub (a different navigator) → iOS shows
          no auto back chevron, so supply one explicitly. */}
      <Stack.Screen
        name="index"
        options={{ title: 'Studio music', headerLeft: () => <BackHeaderLeft label="Studio" fallbackHref="/studio" /> }}
      />
    </Stack>
  )
}
```

- [ ] **Step 2: The screen**

Create `mobile/app/(staff)/sonos/index.jsx`:

```jsx
// SONOSMOB.5 — Studio music: live control of the Sonos speakers.
//
// Control only. Schedules (windows, run-now, the pause override) are set up
// on the web app under Automations → Sonos; this screen lists the location's
// schedules and renders one SonosControlCard per schedule. Today that is one
// card — the studio floor — but a second zone needs no change here.
//
// Gates on `device_control`, cross-platform since SONOSMOB.2: the routes the
// cards call enforce that same key, so the gate and the server agree.

import { useState, useCallback } from 'react'
import { View, Text, Pressable, ScrollView, ActivityIndicator } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useRouter, useFocusEffect } from 'expo-router'
import { useAuth } from '../../../lib/auth-context'
import { canMobile } from '../../../lib/permissions'
import { listSonosSchedules, getSonosHousehold } from '../../../lib/sonos-api'
import SonosControlCard from '../../../components/SonosControlCard'

export default function SonosScreen() {
  const { profile, activeLocation } = useAuth()
  const router = useRouter()
  const locationId = activeLocation?.id
  const allowed = canMobile(profile, 'device_control', activeLocation)

  const [schedules, setSchedules] = useState(null)
  const [favorites, setFavorites] = useState([])
  const [error, setError] = useState(null)

  // Schedules + favourites change rarely: fetched on focus, not polled.
  // The cards poll now-playing themselves.
  const load = useCallback(async () => {
    if (!locationId) return
    const [s, h] = await Promise.all([listSonosSchedules(locationId), getSonosHousehold(locationId)])
    if (!s.success) {
      setError(s.error || 'Could not load studio music')
      return
    }
    setError(null)
    setSchedules(s.schedules || [])
    // A failed favourites read hides the row rather than showing an empty
    // one; the household route flags it separately from "not connected".
    setFavorites(h.success && h.connected && !h.favoritesFailed ? (h.favorites || []) : [])
  }, [locationId])

  useFocusEffect(useCallback(() => {
    if (allowed) load()
  }, [allowed, load]))

  // Permission gate — defence in depth. The Studio tile hides the link
  // without access, but a hand-typed deep link would otherwise reach here.
  if (!allowed) {
    return (
      <View className="flex-1 bg-un1t-bg items-center justify-center p-6">
        <Text className="text-sm text-un1t-subtle text-center">
          Device control isn&apos;t enabled for your role at this location.
        </Text>
        <Pressable onPress={() => router.back()} className="mt-4">
          <Text className="text-sm text-blue-600">Back</Text>
        </Pressable>
      </View>
    )
  }

  return (
    <ScrollView className="flex-1 bg-un1t-bg" contentContainerStyle={{ padding: 16, paddingBottom: 32 }}>
      {error ? (
        <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 flex-row items-start">
          <Ionicons name="alert-circle-outline" size={14} color="#DC2626" style={{ marginTop: 2 }} />
          <Text className="text-xs text-red-700 ml-2 flex-1">{error}</Text>
        </View>
      ) : schedules === null ? (
        <View className="py-8 items-center">
          <ActivityIndicator color="#94A3B8" />
        </View>
      ) : schedules.length === 0 ? (
        <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-4 flex-row items-start">
          <Ionicons name="musical-notes-outline" size={14} color="#94A3B8" style={{ marginTop: 2 }} />
          <Text className="text-xs text-un1t-subtle ml-2 flex-1">
            No studio music is set up for this location yet. An owner sets it up on the
            web app under <Text className="text-un1t-text font-semibold">Automations → Sonos</Text>.
          </Text>
        </View>
      ) : (
        <View className="gap-3">
          {schedules.map((s) => (
            <SonosControlCard key={s.id} schedule={s} favorites={favorites} locationId={locationId} />
          ))}
        </View>
      )}
    </ScrollView>
  )
}
```

- [ ] **Step 3: The Studio-hub tile**

In `mobile/app/(staff)/(tabs)/studio.jsx`:

(a) Extend the header comment's bullet list — after the line `//   • TV displays      → /tv     (view TVs + current content + clear)` add:

```js
//   • Studio music     → /sonos  (live Sonos control — SONOSMOB.5)
```

and after `// the \`tv_displays\` mobile permission.` add to that paragraph:

```js
// Studio music gates on `device_control` (cross-platform since SONOSMOB.2 —
// the same key the /api/sonos/* routes enforce).
```

(b) After

```js
  const canTv = canMobile(profile, 'tv_displays', activeLocation)
```

add

```js
  const canSonos = canMobile(profile, 'device_control', activeLocation)
```

(c) Change the early-return condition

```js
  if (!canStudio && !canTimer && !canTv) {
```

to

```js
  if (!canStudio && !canTimer && !canTv && !canSonos) {
```

(d) After the TV `ChoiceCard` block (the one ending `onPress={() => router.push('/tv')}\n          />\n        )}`), add:

```jsx
        {canSonos && (
          <ChoiceCard
            icon="musical-notes-outline"
            tint="#F59E0B"
            title="Studio music"
            subtitle="Play, pause, volume, favourites"
            onPress={() => router.push('/sonos')}
          />
        )}
```

- [ ] **Step 4: Lint + imports + OTA-path check**

Run: `npm run check:mobile-lint && npm run check:mobile-imports && npm run check:ota-paths`
Expected: all exit 0. `sonos/` is a new directory under `mobile/app/`, which is already a listed trigger path — `check:ota-paths` classifies at the top-level-entry level (`mobile/app`), so nothing to register.

- [ ] **Step 5: Commit**

```bash
git add 'mobile/app/(staff)/sonos/_layout.jsx' 'mobile/app/(staff)/sonos/index.jsx' 'mobile/app/(staff)/(tabs)/studio.jsx'
git commit -m "SONOSMOB.5 — /sonos screen + Studio-hub tile" -m "One SonosControlCard per schedule; favourites from the household route; empty state points at Automations → Sonos on web."
```

---

### Task 6: Full gate, docs, spec status

**Files:**
- Modify: `docs/CHANGELOG.md:8` (insert a row after the table header)
- Modify: `docs/superpowers/specs/2026-08-22-sonos-mobile-control-design.md` (status line)

(`docs/architecture/MOBILE.md` has no per-screen list of the Studio hub — verified — so it needs nothing.)

- [ ] **Step 1: Run the CI mirror**

Run:
```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:bundle-sql && npm run check:ota-paths
```
Expected: every step exits 0. Test count: the helper plan's 16,542 + 7 (`sonos-api.test.js`) + 2 (pair-sync identity tests for the new entry) = 16,551 if built on top of SONOSAPPLY; report the ACTUAL number, do not pad.

- [ ] **Step 2: Run the production build**

Run: `npm run build`
Expected: exits 0 — proves the `@shared/sonos-playback` shim resolves under Turbopack.

- [ ] **Step 3: CHANGELOG row**

Insert directly under the `|---|------|-------|` header line in `docs/CHANGELOG.md` (use the next free number — 565 if SONOSAPPLY.4 landed 564 first; check the top row):

```markdown
| 565 | SONOSMOB.1-5 — Sonos live control on the staff mobile app | Studio hub → "Studio music" → one control card per schedule: now-playing readout, previous/play-pause/next, ±5 volume steps (a slider is a native dep → next binary), favourite chips. No new server code: rides `/api/sonos/{schedules,household,now-playing,control}` through `api()`. `device_control` is now in `CROSS_PLATFORM_KEYS` (those routes enforce the top-level key — the `email_inbox` rule) and off `WEB_ONLY_OK`; scheduling/run-now/pause override stay web-only. The playback enum moved to `shared/sonos-playback.js` (web shim + pair-sync `reexport` entry). Publishes an OTA at 100% on merge. Spec: `docs/superpowers/specs/2026-08-22-sonos-mobile-control-design.md`. |
```

- [ ] **Step 4: Mark the spec shipped**

In `docs/superpowers/specs/2026-08-22-sonos-mobile-control-design.md`, change the `**Status:**` line to `**Status:** implemented (SONOSMOB.1-5)`.

- [ ] **Step 5: Commit**

```bash
git add docs/CHANGELOG.md docs/superpowers/specs/2026-08-22-sonos-mobile-control-design.md
git commit -m "SONOSMOB.6 — changelog + spec status"
```

---

## Self-review against the spec

- **Decision 1 (cross-platform key, WEB_ONLY_OK removal, hint/comment)** → Task 2. ✔
- **Decision 2 (hub tile, `permKeys`, `/sonos` + layout, hub OR-gate)** → Task 2 Step 5 + Task 5. ✔
- **Decision 3 (readout, transport, favourites as chips, unavailable-state copy, partial-failure notice, no `sonos_schedules` writes, empty state, schedules + favourites fetched on focus)** → Tasks 4, 5. ✔
- **Decision 4 (step buttons, coalescing, optimistic revert, `volumeFailed` before `fixedVolume`)** → Task 4. ✔
- **Decision 5 (enum to `shared/`, shim, manifest `reexport` entry with explicit paths)** → Task 1. ✔
- **Wire layer through `api()`, `value` omitted when undefined, envelope passed through** → Task 3. ✔
- **Polling 10 s on focus, cleared on blur, immediate reload after an action** → Task 4 `useNowPlaying` + `send`. ✔
- **OTA note, no runtimeVersion bump, nothing for `check:ota-paths`** → Task 5 Step 4, Task 6. ✔
- **Tests listed in spec** → `shared/sonos-playback.test.js` (Task 1), `mobile/lib/sonos-api.test.js` (Task 3), gates (Tasks 2, 4, 5, 6). ✔
- Type consistency: `sendSonosAction(scheduleId, action, value, locationId)` identical in Tasks 3 and 4; `getSonosNowPlaying(scheduleId, locationId)` identical in Tasks 3 and 4; `SonosControlCard({ schedule, favorites, locationId })` identical in Tasks 4 and 5; household fields `connected` / `favorites` / `favoritesFailed` match `src/app/api/sonos/household/route.js`. ✔
