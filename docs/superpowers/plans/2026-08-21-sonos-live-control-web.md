# Sonos Live Control (Web) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give operators immediate control of the studio Sonos — volume, transport, favourite, and a live now-playing readout — and rebuild "Run now" so it acts instantly instead of clearing state and waiting for a cron tick.

**Architecture:** One action-dispatched route (`POST /api/sonos/control`) plus a read route (`GET /api/sonos/now-playing`), both targeting a schedule so the existing ephemeral-group resolution is reused. Live actions write **nothing** to `sonos_schedules` — the schedule acts only at window boundaries, so a live change simply persists until the next one. Run-now is the single exception: it applies the active window through the same path and stamps `last_applied` as an open.

**Tech Stack:** Next.js 16 App Router (JavaScript, not TypeScript), Supabase service-role, vitest, Zod, Tailwind.

**Spec:** `docs/superpowers/specs/2026-08-21-sonos-live-control-design.md`

**Scope:** Web only. Mobile is a separate plan — it adds no Sonos logic but carries parity, OTA and `authHeaders()` ceremony.

---

## Conventions this codebase already has

- **Tests are colocated:** `src/lib/sonos/client.js` → `src/lib/sonos/client.test.js`. Run one file with `npx vitest run <path>`; everything with `npm test`.
- **Service-role API routes get no RLS**, so they authorise in app code: `getCurrentUser()` → 401, `hasPermission(user, 'device_control')` → 403, then scope every query by `user.activeLocation.id`. `.eq('location_id', …)` belongs on the query itself, not a read-then-check.
- **Detail routes 404 on a malformed id** (via `uuidLike` from `@/lib/schemas`), never 400 or a raw Postgres 500 — ids must not be enumerable.
- **Sonos client calls never throw.** They resolve to `{ ok, statusCode, body }`, or `{ ok: false, statusCode: 0, networkError: true, body: null }`.
- **Register every new route in `src/lib/openapi.js`.** The six existing Sonos routes are already registered there; these two join them.
- **Commit style:** `TAG.N — lowercase summary`. Use `git commit -F <file>` or a heredoc — `-m` with backticks triggers shell command substitution and silently mangles the message.
- **Design tokens:** light theme, `un1t-*` intent tokens only. A dead token name emits **no CSS at all**. Status chips are `bg-<c>-500/10 text-<c>-700` — never `text-*-300/400/500` on a light surface. Every non-submit `<button>` needs `type="button"`. All lint-enforced by `check:guardrails`.

## Environment gotchas (learned the hard way on the previous plan)

- The sandbox Bash verifier **rejects any command containing the bare word `source`**, even quoted, and rejects heredoc `>>` appends as too complex. Use Read/Write/Edit tools for file content.
- A PreToolUse security hook pattern-matches JavaScript's regular-expression execute method and rejects the write when it appears literally — prefer `.test()` or `.match()` in both code and prose.
- Bracketed path segments like `[id]` are zsh globs — quote them.
- Stage only your own files. Never `git add -A`.

## File structure

**Create:**

| File | Responsibility |
|---|---|
| `src/lib/sonos/actions.js` | Pure: the action table mapping an action name to a client call and its argument shape. No I/O. |
| `src/lib/sonos/actions.test.js` | Tests for the above. |
| `src/lib/sonos/live.js` | Live-action orchestration with injected I/O. Where the "writes nothing" property is enforced and tested. |
| `src/lib/sonos/live.test.js` | Tests for the above. |
| `src/app/api/sonos/control/route.js` | `POST` — thin wrapper: authorise, validate, map result codes to HTTP. |
| `src/app/api/sonos/now-playing/route.js` | `GET` — volume + metadata + playback state for a schedule's group. |
| `src/components/automations/SonosLiveControl.jsx` | The control strip. Rendered inside `ScheduleCard`. |

**Modify:**

| File | Change |
|---|---|
| `src/lib/sonos/client.js` | Add six calls: play, skipNext, skipPrevious, setRelativeVolume, getGroupVolume, getMetadata. |
| `src/app/api/sonos/schedules/[id]/run-now/route.js` | Rebuild: apply the active window immediately, stamp `last_applied`, stop clearing it. |
| `src/components/automations/SonosScheduleClient.jsx` | Render `<SonosLiveControl>` in `ScheduleCard`. |
| `src/lib/openapi.js` | Register the two new routes; update run-now's description. |

---

## Task 1: Six new client calls

**Files:**
- Modify: `src/lib/sonos/client.js`
- Test: `src/lib/sonos/client.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/sonos/client.test.js` in a new describe block. The file already defines `cfg` at module scope and already mocks `global.fetch` in sibling blocks — follow that same pattern.

```js
import {
  sonosPlay, sonosSkipNext, sonosSkipPrevious,
  sonosSetRelativeVolume, sonosGetGroupVolume, sonosGetMetadata,
} from './client'

describe('live control calls', () => {
  beforeEach(() => { global.fetch = vi.fn() })
  afterEach(() => { vi.restoreAllMocks() })

  const okEmpty = { ok: true, status: 200, text: async () => '{}' }

  it('plays a group', async () => {
    global.fetch.mockResolvedValue(okEmpty)
    await sonosPlay('tok', 'GRP1')
    const [url, opts] = global.fetch.mock.calls[0]
    expect(url).toBe('https://api.ws.sonos.com/control/api/v1/groups/GRP1/playback/play')
    expect(opts.method).toBe('POST')
  })

  it('skips forward and back on the documented paths', async () => {
    global.fetch.mockResolvedValue(okEmpty)
    await sonosSkipNext('tok', 'GRP1')
    await sonosSkipPrevious('tok', 'GRP1')
    expect(global.fetch.mock.calls[0][0])
      .toBe('https://api.ws.sonos.com/control/api/v1/groups/GRP1/playback/skipToNextTrack')
    expect(global.fetch.mock.calls[1][0])
      .toBe('https://api.ws.sonos.com/control/api/v1/groups/GRP1/playback/skipToPreviousTrack')
  })

  it('sends a relative volume delta, not an absolute level', async () => {
    // Absolute volume for a +/- button makes two people pressing "+" fight
    // each other: each sends current+5 read from its own stale view.
    global.fetch.mockResolvedValue(okEmpty)
    await sonosSetRelativeVolume('tok', 'GRP1', -5)
    const [url, opts] = global.fetch.mock.calls[0]
    expect(url).toBe('https://api.ws.sonos.com/control/api/v1/groups/GRP1/groupVolume/relative')
    expect(JSON.parse(opts.body)).toEqual({ volumeDelta: -5 })
  })

  it('clamps a relative delta into the -100..100 Sonos accepts', async () => {
    global.fetch.mockResolvedValue(okEmpty)
    await sonosSetRelativeVolume('tok', 'GRP1', 900)
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual({ volumeDelta: 100 })
    await sonosSetRelativeVolume('tok', 'GRP1', -900)
    expect(JSON.parse(global.fetch.mock.calls[1][1].body)).toEqual({ volumeDelta: -100 })
  })

  it('rounds a fractional delta rather than sending a float', async () => {
    global.fetch.mockResolvedValue(okEmpty)
    await sonosSetRelativeVolume('tok', 'GRP1', 2.6)
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual({ volumeDelta: 3 })
  })

  it('reads group volume including the fixed flag', async () => {
    global.fetch.mockResolvedValue({
      ok: true, status: 200,
      text: async () => JSON.stringify({ volume: 22, muted: false, fixed: true }),
    })
    const out = await sonosGetGroupVolume('tok', 'GRP1')
    const [url, opts] = global.fetch.mock.calls[0]
    expect(url).toBe('https://api.ws.sonos.com/control/api/v1/groups/GRP1/groupVolume')
    expect(opts.method).toBe('GET')
    expect(out.body).toEqual({ volume: 22, muted: false, fixed: true })
  })

  it('reads playback metadata', async () => {
    global.fetch.mockResolvedValue({ ok: true, status: 200, text: async () => '{}' })
    await sonosGetMetadata('tok', 'GRP1')
    expect(global.fetch.mock.calls[0][0])
      .toBe('https://api.ws.sonos.com/control/api/v1/groups/GRP1/playbackMetadata')
  })

  it('never throws when the network dies', async () => {
    global.fetch.mockRejectedValue(new Error('ECONNRESET'))
    await expect(sonosPlay('tok', 'GRP1')).resolves.toMatchObject({ ok: false, statusCode: 0 })
  })
})
```

- [ ] **Step 2: Run to confirm they fail**

Run: `npx vitest run src/lib/sonos/client.test.js -t "live control"`
Expected: FAIL — `sonosPlay is not a function`.

- [ ] **Step 3: Implement**

Append to `src/lib/sonos/client.js`, below the existing `sonosPause`:

```js
export function sonosPlay(token, groupId) {
  return apiCall(token, 'POST', `/groups/${enc(groupId)}/playback/play`)
}

export function sonosSkipNext(token, groupId) {
  return apiCall(token, 'POST', `/groups/${enc(groupId)}/playback/skipToNextTrack`)
}

export function sonosSkipPrevious(token, groupId) {
  return apiCall(token, 'POST', `/groups/${enc(groupId)}/playback/skipToPreviousTrack`)
}

// Relative, not absolute — Sonos documents this split, and it matters for
// more than tidiness. Absolute volume for a +/- button means each caller
// sends `current + step` computed from its OWN possibly-stale reading, so
// two people pressing "+" at once overwrite each other. A delta is
// commutative. Sonos clamps the resulting level into 0-100 itself; the
// delta must be an integer in -100..100.
export function sonosSetRelativeVolume(token, groupId, delta) {
  const d = Math.max(-100, Math.min(100, Math.round(Number(delta) || 0)))
  return apiCall(token, 'POST', `/groups/${enc(groupId)}/groupVolume/relative`, { volumeDelta: d })
}

// → body { volume, muted, fixed }. `fixed: true` means the group is wired
// to a fixed-level output and volume commands do nothing — the UI must say
// so rather than sending commands that silently no-op.
export function sonosGetGroupVolume(token, groupId) {
  return apiCall(token, 'GET', `/groups/${enc(groupId)}/groupVolume`)
}

// → body { container: { name, service: { name } },
//          currentItem: { track: { name, artist: { name }, album: { name }, imageUrl } } }
// Every field is nullable per Sonos.
export function sonosGetMetadata(token, groupId) {
  return apiCall(token, 'GET', `/groups/${enc(groupId)}/playbackMetadata`)
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/sonos/client.test.js`
Expected: PASS — the pre-existing tests plus 8 new ones.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sonos/client.js src/lib/sonos/client.test.js
git commit -m "SONOSLIVE.1 — client calls for play, skip, relative volume and now-playing reads"
```

---

## Task 2: The pure action table

Keeping dispatch out of the route means the mapping is testable without HTTP or a database, and adding an action later is a one-line change in a tested table.

**Files:**
- Create: `src/lib/sonos/actions.js`
- Test: `src/lib/sonos/actions.test.js`

- [ ] **Step 1: Write the failing test**

Create `src/lib/sonos/actions.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { ACTIONS, planLiveAction } from './actions'

describe('planLiveAction', () => {
  it('rejects an unknown action', () => {
    expect(planLiveAction('reboot_everything')).toBe(null)
  })

  it('rejects a missing action', () => {
    expect(planLiveAction(undefined)).toBe(null)
    expect(planLiveAction('')).toBe(null)
  })

  it('maps volume_up to a positive relative delta with a default step', () => {
    expect(planLiveAction('volume_up')).toMatchObject({ call: 'setRelativeVolume', args: [5] })
  })

  it('maps volume_down to a negative delta', () => {
    expect(planLiveAction('volume_down')).toMatchObject({ call: 'setRelativeVolume', args: [-5] })
  })

  it('honours an explicit step and keeps the sign of the direction', () => {
    expect(planLiveAction('volume_up', 10)).toMatchObject({ args: [10] })
    expect(planLiveAction('volume_down', 10)).toMatchObject({ args: [-10] })
  })

  it('reads a negative step as a size, not an instruction to invert', () => {
    // volume_down with a step of -10 must still go DOWN.
    expect(planLiveAction('volume_down', -10)).toMatchObject({ args: [-10] })
    expect(planLiveAction('volume_up', -10)).toMatchObject({ args: [10] })
  })

  it('maps set_volume to an absolute level', () => {
    expect(planLiveAction('set_volume', 35)).toMatchObject({ call: 'setVolume', args: [35] })
  })

  it('rejects set_volume without a usable level', () => {
    expect(planLiveAction('set_volume')).toBe(null)
    expect(planLiveAction('set_volume', 'loud')).toBe(null)
  })

  it('accepts a zero volume, which is falsy but valid', () => {
    expect(planLiveAction('set_volume', 0)).toMatchObject({ call: 'setVolume', args: [0] })
  })

  it('rejects an out-of-range absolute volume rather than silently clamping', () => {
    // The client clamps defensively, but a 140 from a caller is a bug in
    // that caller and should be reported, not quietly turned into 100.
    expect(planLiveAction('set_volume', 140)).toBe(null)
    expect(planLiveAction('set_volume', -1)).toBe(null)
  })

  it('maps the transport actions', () => {
    expect(planLiveAction('play')).toMatchObject({ call: 'play', args: [] })
    expect(planLiveAction('pause')).toMatchObject({ call: 'pause', args: [] })
    expect(planLiveAction('skip_next')).toMatchObject({ call: 'skipNext', args: [] })
    expect(planLiveAction('skip_previous')).toMatchObject({ call: 'skipPrevious', args: [] })
  })

  it('maps load_favorite with the favourite id', () => {
    expect(planLiveAction('load_favorite', '125')).toMatchObject({ call: 'loadFavorite', args: ['125'] })
  })

  it('rejects load_favorite with no id', () => {
    expect(planLiveAction('load_favorite')).toBe(null)
    expect(planLiveAction('load_favorite', '')).toBe(null)
  })

  it('flags which actions change volume, so a fixed-volume group can refuse them', () => {
    expect(planLiveAction('volume_up').touchesVolume).toBe(true)
    expect(planLiveAction('set_volume', 20).touchesVolume).toBe(true)
    expect(planLiveAction('play').touchesVolume).toBe(false)
  })

  it('exposes the closed action list', () => {
    expect(ACTIONS).toEqual([
      'volume_up', 'volume_down', 'set_volume',
      'play', 'pause', 'skip_next', 'skip_previous', 'load_favorite',
    ])
  })
})
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run src/lib/sonos/actions.test.js`
Expected: FAIL — `Failed to resolve import "./actions"`.

- [ ] **Step 3: Implement**

Create `src/lib/sonos/actions.js`:

```js
// SONOSLIVE.2 — the closed action list for live control, and the pure
// mapping from an action name to a client call.
//
// Closed on purpose: an open-ended pass-through to the Sonos API cannot be
// meaningfully permission-gated, so the list IS the security boundary. One
// permission check on the route covers everything in it.
//
// No I/O here — this returns which call to make and with what, so dispatch
// is testable without HTTP or a database.

const DEFAULT_VOLUME_STEP = 5

export const ACTIONS = [
  'volume_up', 'volume_down', 'set_volume',
  'play', 'pause', 'skip_next', 'skip_previous', 'load_favorite',
]

const isInt = (v) => Number.isFinite(Number(v)) && Number.isInteger(Number(v))

// → null (unknown action or unusable value)
//   | { call, args, touchesVolume }
//
// `call` names an entry in the route's client map. `touchesVolume` lets the
// caller refuse volume changes on a group Sonos reports as fixed-level.
export function planLiveAction(action, value) {
  switch (action) {
    case 'volume_up':
    case 'volume_down': {
      // A caller sending a negative step means "a step of this size", not
      // "invert my direction" — direction lives in the action name.
      const raw = value === undefined || value === null ? DEFAULT_VOLUME_STEP : Number(value)
      if (!Number.isFinite(raw)) return null
      const size = Math.abs(Math.round(raw))
      if (size < 1 || size > 100) return null
      const delta = action === 'volume_up' ? size : -size
      return { call: 'setRelativeVolume', args: [delta], touchesVolume: true }
    }

    case 'set_volume': {
      if (!isInt(value)) return null
      const level = Number(value)
      // Out of range is a caller bug. The client clamps defensively, but
      // silently turning 140 into 100 hides the mistake from whoever sent it.
      if (level < 0 || level > 100) return null
      return { call: 'setVolume', args: [level], touchesVolume: true }
    }

    case 'play':          return { call: 'play', args: [], touchesVolume: false }
    case 'pause':         return { call: 'pause', args: [], touchesVolume: false }
    case 'skip_next':     return { call: 'skipNext', args: [], touchesVolume: false }
    case 'skip_previous': return { call: 'skipPrevious', args: [], touchesVolume: false }

    case 'load_favorite': {
      const id = typeof value === 'string' ? value.trim() : ''
      if (!id) return null
      return { call: 'loadFavorite', args: [id], touchesVolume: false }
    }

    default:
      return null
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/sonos/actions.test.js`
Expected: PASS (15 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/sonos/actions.js src/lib/sonos/actions.test.js
git commit -m "SONOSLIVE.2 — the closed live-action table, pure and tested"
```

---

## Task 3: The live-action orchestration (testable, injected I/O)

**Why this is a lib module and not the route body.** The spec requires tests for location scoping, the fixed-volume refusal, and — most importantly — an assertion that a live action **writes nothing to `sonos_schedules`**. This codebase has no route-level tests for any Sonos, Tapo or Xero route, and that is a deliberate convention, not an oversight. The established pattern for testable orchestration is `src/lib/sonos/reconcile.js`: all I/O injected, the route a thin wrapper. Follow it, and the properties that matter become assertable with fakes.

**Files:**
- Create: `src/lib/sonos/live.js`
- Test: `src/lib/sonos/live.test.js`

- [ ] **Step 1: Write the failing test**

Create `src/lib/sonos/live.test.js`:

```js
import { describe, it, expect, vi } from 'vitest'
import { runLiveAction } from './live'

const groupsBody = {
  groups: [{ id: 'GRP_A', name: 'Studio', playbackState: 'PLAYBACK_STATE_PLAYING', playerIds: ['RINCON_1'] }],
  players: [{ id: 'RINCON_1', name: 'Floor' }],
}

const schedule = { id: 's1', player_ids: ['RINCON_1'] }

// Records every table touched so a test can prove no write happened.
function makeDb(row, touched = []) {
  return {
    touched,
    from(table) {
      touched.push(table)
      return {
        select: () => ({
          eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }),
        }),
        update() { throw new Error(`unexpected write to ${table}`) },
        insert() { throw new Error(`unexpected write to ${table}`) },
        delete() { throw new Error(`unexpected write to ${table}`) },
      }
    },
  }
}

const deps = (over = {}) => ({
  getConfig: () => ({ clientId: 'a', clientSecret: 'b', redirectUri: 'https://x/cb' }),
  getToken: async () => ({ ok: true, token: 'tok', householdId: 'HH1' }),
  getGroups: async () => ({ ok: true, statusCode: 200, body: groupsBody }),
  getGroupVolume: async () => ({ ok: true, statusCode: 200, body: { volume: 20, muted: false, fixed: false } }),
  call: vi.fn(async () => ({ ok: true, statusCode: 200 })),
  ...over,
})

describe('runLiveAction', () => {
  it('dispatches the planned call to the resolved group', async () => {
    const d = deps()
    const out = await runLiveAction(makeDb(schedule), 'loc-1', 's1', 'volume_up', undefined, d)
    expect(out).toMatchObject({ ok: true, groups: ['GRP_A'] })
    expect(d.call).toHaveBeenCalledWith('setRelativeVolume', 'tok', 'GRP_A', 5)
  })

  it('WRITES NOTHING to sonos_schedules', async () => {
    // The property that keeps live control and the schedule from fighting.
    // The fake db throws on any update/insert/delete, so a future
    // "helpful" stamp of last_applied fails loudly here instead of
    // silently breaking the close.
    const touched = []
    await runLiveAction(makeDb(schedule, touched), 'loc-1', 's1', 'pause', undefined, deps())
    expect(touched).toEqual(['sonos_schedules']) // the SELECT only
  })

  it('refuses an unknown action before touching anything', async () => {
    const d = deps()
    const out = await runLiveAction(makeDb(schedule), 'loc-1', 's1', 'reboot', undefined, d)
    expect(out).toMatchObject({ ok: false, code: 'invalid' })
    expect(d.call).not.toHaveBeenCalled()
  })

  it('reports not-found when the schedule belongs to another location', async () => {
    // makeDb(null) models the .eq('location_id') filter matching nothing.
    const d = deps()
    const out = await runLiveAction(makeDb(null), 'loc-1', 's1', 'play', undefined, d)
    expect(out).toMatchObject({ ok: false, code: 'not_found' })
    expect(d.call).not.toHaveBeenCalled()
  })

  it('refuses a volume change on a fixed-volume group', async () => {
    const d = deps({
      getGroupVolume: async () => ({ ok: true, statusCode: 200, body: { volume: 20, fixed: true } }),
    })
    const out = await runLiveAction(makeDb(schedule), 'loc-1', 's1', 'volume_up', undefined, d)
    expect(out).toMatchObject({ ok: false, code: 'fixed_volume' })
    expect(d.call).not.toHaveBeenCalled()
  })

  it('does not check the fixed flag for a non-volume action', async () => {
    const getGroupVolume = vi.fn()
    await runLiveAction(makeDb(schedule), 'loc-1', 's1', 'skip_next', undefined, deps({ getGroupVolume }))
    expect(getGroupVolume).not.toHaveBeenCalled()
  })

  it('surfaces a regroup as retryable rather than retrying in-request', async () => {
    const d = deps({ call: vi.fn(async () => ({ ok: false, statusCode: 404 })) })
    const out = await runLiveAction(makeDb(schedule), 'loc-1', 's1', 'play', undefined, d)
    expect(out).toMatchObject({ ok: false, code: 'regrouped' })
  })

  it('reports an empty queue distinctly from a generic failure', async () => {
    const d = deps({ call: vi.fn(async () => ({ ok: false, statusCode: 499 })) })
    const out = await runLiveAction(makeDb(schedule), 'loc-1', 's1', 'play', undefined, d)
    expect(out).toMatchObject({ ok: false, code: 'no_content' })
  })

  it('reports rate limiting distinctly', async () => {
    const d = deps({ call: vi.fn(async () => ({ ok: false, statusCode: 429 })) })
    const out = await runLiveAction(makeDb(schedule), 'loc-1', 's1', 'play', undefined, d)
    expect(out).toMatchObject({ ok: false, code: 'rate_limited' })
  })

  it('reports a disconnected household without throwing', async () => {
    const d = deps({ getToken: async () => ({ ok: false, reason: 'not_connected' }) })
    const out = await runLiveAction(makeDb(schedule), 'loc-1', 's1', 'play', undefined, d)
    expect(out).toMatchObject({ ok: false, code: 'not_connected' })
  })

  it('reports no online speakers when the players resolve to no group', async () => {
    const d = deps({ getGroups: async () => ({ ok: true, statusCode: 200, body: { groups: [], players: [] } }) })
    const out = await runLiveAction(makeDb(schedule), 'loc-1', 's1', 'play', undefined, d)
    expect(out).toMatchObject({ ok: false, code: 'no_group' })
  })

  it('is dormant when Sonos is not configured', async () => {
    const out = await runLiveAction(makeDb(schedule), 'loc-1', 's1', 'play', undefined, deps({ getConfig: () => null }))
    expect(out).toMatchObject({ ok: false, code: 'not_configured' })
  })
})
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run src/lib/sonos/live.test.js`
Expected: FAIL — `Failed to resolve import "./live"`.

- [ ] **Step 3: Implement**

Create `src/lib/sonos/live.js`:

```js
// SONOSLIVE.3 — live control orchestration. All I/O injected so the
// properties that matter are testable with fakes (house pattern:
// src/lib/sonos/reconcile.js).
//
// THIS WRITES NOTHING TO sonos_schedules, deliberately. The schedule acts
// only at window boundaries and ignores everything in between, so a live
// change simply persists until the next boundary — no suppression, no
// reconciliation, no new state. There is a test asserting this; if someone
// later adds a "helpful" last_applied stamp here, it fails loudly rather
// than silently breaking the close.
//
// It also works while the schedule is disabled or overridden: both govern
// whether the CRON acts, not whether a human may. Someone who just
// suppressed the schedule for a private event is exactly who then wants to
// set the volume by hand — which is why neither field is even read here.

import { logWarn } from '@/lib/log'
import {
  getSonosConfig, withFreshToken, sonosGetGroups, sonosGetGroupVolume,
  sonosSetGroupVolume, sonosSetRelativeVolume, sonosLoadFavorite,
  sonosPlay, sonosPause, sonosSkipNext, sonosSkipPrevious,
} from './client'
import { mapGroups, resolveGroupIds } from './groups'
import { planLiveAction } from './actions'

const MODULE = 'sonos-live'

const CLIENT = {
  setVolume: sonosSetGroupVolume,
  setRelativeVolume: sonosSetRelativeVolume,
  loadFavorite: sonosLoadFavorite,
  play: sonosPlay,
  pause: sonosPause,
  skipNext: sonosSkipNext,
  skipPrevious: sonosSkipPrevious,
}

const defaultCall = (name, token, groupId, ...args) => CLIENT[name](token, groupId, ...args)

// → { ok: true, groups } | { ok: false, code, reason?, statusCode? }
// `code` is a stable tag the route maps to an HTTP status and copy.
export async function runLiveAction(db, locationId, scheduleId, action, value, deps = {}) {
  const {
    getConfig = () => getSonosConfig(),
    getToken = withFreshToken,
    getGroups = sonosGetGroups,
    getGroupVolume = sonosGetGroupVolume,
    call = defaultCall,
  } = deps

  const plan = planLiveAction(action, value)
  if (!plan) return { ok: false, code: 'invalid' }

  const cfg = getConfig()
  if (!cfg) return { ok: false, code: 'not_configured' }
  if (cfg.error) return { ok: false, code: 'not_configured', reason: cfg.error }

  // Location scoping lives on the query, not a read-then-check: a schedule
  // id from another location must be indistinguishable from one that does
  // not exist.
  const { data: schedule, error } = await db
    .from('sonos_schedules')
    .select('id, player_ids')
    .eq('id', scheduleId)
    .eq('location_id', locationId)
    .maybeSingle()
  if (error) return { ok: false, code: 'db_error', reason: error.message }
  if (!schedule) return { ok: false, code: 'not_found' }

  const tok = await getToken(db, locationId, cfg)
  if (!tok.ok) return { ok: false, code: 'not_connected', reason: tok.reason }

  const groupsRes = await getGroups(tok.token, tok.householdId)
  if (!groupsRes.ok) return { ok: false, code: 'unreachable', statusCode: groupsRes.statusCode }

  const { groups } = mapGroups(groupsRes.body)
  const groupIds = resolveGroupIds(groups, schedule.player_ids)
  if (!groupIds.length) return { ok: false, code: 'no_group' }

  // A fixed-level group ignores volume commands. Refuse rather than firing
  // something that silently does nothing. Only checked when it matters —
  // an extra GET on every skip would be waste.
  if (plan.touchesVolume) {
    const vol = await getGroupVolume(tok.token, groupIds[0])
    if (vol.ok && vol.body?.fixed === true) return { ok: false, code: 'fixed_volume' }
  }

  const results = []
  for (const groupId of groupIds) {
    results.push(await call(plan.call, tok.token, groupId, ...plan.args))
  }

  const failed = results.find((r) => !r.ok)
  if (failed) {
    logWarn(MODULE, 'action failed', { scheduleId, action, statusCode: failed.statusCode })
    // 404 = the group changed between resolve and act. Retryable, but not
    // retried in-request — the caller re-resolves on their next attempt.
    if (failed.statusCode === 404) return { ok: false, code: 'regrouped' }
    if (failed.statusCode === 499) return { ok: false, code: 'no_content' }
    if (failed.statusCode === 429) return { ok: false, code: 'rate_limited' }
    return { ok: false, code: 'failed', statusCode: failed.statusCode }
  }

  return { ok: true, groups: groupIds }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/sonos/live.test.js`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/sonos/live.js src/lib/sonos/live.test.js
git commit -m "SONOSLIVE.3 — live action orchestration, and a test that it writes nothing"
```

---

## Task 4: The control route (thin wrapper)

**Files:**
- Create: `src/app/api/sonos/control/route.js`

- [ ] **Step 1: Write the route**

```js
// SONOSLIVE.4 — immediate live control. One action-dispatched route rather
// than six sub-routes (six auth checks, six OpenAPI entries, no benefit) or
// a pass-through proxy (an unbounded action set cannot be permission-gated).
//
// Thin by design: runLiveAction (src/lib/sonos/live.js) is the tested body,
// including the assertion that it writes nothing to sonos_schedules. This
// file only authorises, validates the request, and maps result codes to
// HTTP statuses and operator-readable copy.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { uuidLike } from '@/lib/schemas'
import { ACTIONS } from '@/lib/sonos/actions'
import { runLiveAction } from '@/lib/sonos/live'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.object({
  schedule_id: z.string(),
  action: z.enum(ACTIONS),
  value: z.union([z.number(), z.string()]).optional(),
})

// Result code → HTTP status + what the operator reads.
const OUTCOME = {
  invalid:        [400, 'Invalid request'],
  not_found:      [404, 'Not found'],
  not_configured: [503, 'Sonos is not configured'],
  not_connected:  [409, 'Sonos is not connected'],
  no_group:       [409, 'None of this schedule’s speakers are online'],
  fixed_volume:   [409, 'These speakers are set to a fixed volume, so it cannot be changed from here'],
  regrouped:      [409, 'The speakers regrouped — try that again'],
  no_content:     [409, 'Nothing is loaded on these speakers — pick a favourite first'],
  rate_limited:   [429, 'Too many changes at once — give it a moment'],
  unreachable:    [502, 'Sonos is not answering right now'],
  db_error:       [500, 'Something went wrong'],
  failed:         [502, 'That did not work'],
}

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'device_control')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const locationId = user.activeLocation?.id
  if (!locationId) return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })

  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'Invalid request' }, { status: 400 })
  }
  const { schedule_id: scheduleId, action, value } = parsed.data
  if (!uuidLike.safeParse(scheduleId).success) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  const db = createServerClient()
  const out = await runLiveAction(db, locationId, scheduleId, action, value)
  if (out.ok) return NextResponse.json({ success: true, groups: out.groups })

  const [status, message] = OUTCOME[out.code] || [502, 'That did not work']
  return NextResponse.json({ success: false, error: message, code: out.code }, { status })
}
```

- [ ] **Step 2: Verify the guard scripts pass**

Run: `npm run check:route-guards && npm run check:location-scoping && npm run check:guardrails`
Expected: all PASS.

- [ ] **Step 3: Confirm every result code has an outcome**

Run: `grep -n "code: '" src/lib/sonos/live.js`

Every distinct `code` value in that output must appear as a key in this route's `OUTCOME` map. A missing one silently falls through to a generic 502, which would hide a specific, actionable message. Check them off one by one.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/sonos/control/route.js
git commit -m "SONOSLIVE.4 — the live control route, one closed action list"
```

---

## Task 5: The now-playing route

**Files:**
- Create: `src/app/api/sonos/now-playing/route.js`

- [ ] **Step 1: Write the route**

```js
// SONOSLIVE.5 — live readout for the control strip.
//
// Playback state comes from the household groups response already fetched
// to resolve the group, so it costs no extra call. Volume and metadata are
// two more GETs. Polled every 10s while a strip is open: 12 requests/min
// against a 1000/min quota.
//
// Every metadata field is nullable per Sonos, so the consumer must degrade
// to "playing, no track detail" rather than rendering blanks.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { uuidLike } from '@/lib/schemas'
import { getSonosConfig, withFreshToken, sonosGetGroups, sonosGetGroupVolume, sonosGetMetadata } from '@/lib/sonos/client'
import { mapGroups, resolveGroupIds } from '@/lib/sonos/groups'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'device_control')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const locationId = user.activeLocation?.id
  if (!locationId) return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })

  const scheduleId = new URL(request.url).searchParams.get('schedule_id') || ''
  if (!uuidLike.safeParse(scheduleId).success) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  const cfg = getSonosConfig()
  if (!cfg || cfg.error) return NextResponse.json({ success: true, live: false, reason: 'not_configured' })

  const db = createServerClient()
  const { data: schedule, error } = await db
    .from('sonos_schedules')
    .select('id, player_ids')
    .eq('id', scheduleId)
    .eq('location_id', locationId)
    .maybeSingle()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  if (!schedule) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  const tok = await withFreshToken(db, locationId, cfg)
  if (!tok.ok) return NextResponse.json({ success: true, live: false, reason: tok.reason })

  const groupsRes = await sonosGetGroups(tok.token, tok.householdId)
  if (!groupsRes.ok) {
    return NextResponse.json({ success: true, live: false, reason: 'unreachable', statusCode: groupsRes.statusCode })
  }
  const { groups } = mapGroups(groupsRes.body)
  const groupIds = resolveGroupIds(groups, schedule.player_ids)
  if (!groupIds.length) return NextResponse.json({ success: true, live: false, reason: 'no_group' })

  const groupId = groupIds[0]
  const group = groups.find((g) => g.id === groupId)

  const [volRes, metaRes] = await Promise.all([
    sonosGetGroupVolume(tok.token, groupId),
    sonosGetMetadata(tok.token, groupId),
  ])

  const track = metaRes.body?.currentItem?.track || null

  return NextResponse.json({
    success: true,
    live: true,
    groupId,
    playbackState: group?.playbackState || null,
    volume: volRes.ok ? (volRes.body?.volume ?? null) : null,
    muted: volRes.ok ? (volRes.body?.muted ?? null) : null,
    fixedVolume: volRes.ok ? (volRes.body?.fixed === true) : false,
    volumeFailed: !volRes.ok,
    track: track
      ? {
          name: track.name || null,
          artist: track.artist?.name || null,
          album: track.album?.name || null,
          imageUrl: track.imageUrl || null,
        }
      : null,
    source: metaRes.body?.container?.name || metaRes.body?.container?.service?.name || null,
  })
}
```

- [ ] **Step 2: Verify the guard scripts pass**

Run: `npm run check:route-guards && npm run check:location-scoping`
Expected: both PASS.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/sonos/now-playing/route.js
git commit -m "SONOSLIVE.5 — now-playing readout for the control strip"
```

---

## Task 6: Rebuild "Run now" so it acts immediately

This is the bug fix. As shipped, run-now sets `last_applied = null` so the next cron tick re-fires. That field is also the **close's precondition** — `planAction` only closes a window it has a record of opening. Clear it, and if the window ends before a re-open lands, the close never fires and the music plays on.

Observed live on 2026-08-21: opened 20:55:31, run-now at 20:56:08 cleared the record, the window's `off` was then edited to an already-past time, and the row went unwritten for 72 minutes with nothing scheduled to stop the music until the next morning.

**Files:**
- Modify: `src/app/api/sonos/schedules/[id]/run-now/route.js`

- [ ] **Step 1: Replace the route**

Replace the whole file with:

```js
// SONOSLIVE.6 — "run now" applies the active window immediately.
//
// It used to set last_applied = null and let the next cron tick re-fire.
// That was wrong twice over. It was not immediate (up to 60s), and
// last_applied is also the CLOSE's precondition: planAction will only close
// a window it has a record of opening, deliberately, so that recovery after
// downtime cannot silence music a human started by hand. Clearing that
// record meant that if the window ended before a re-open landed, the close
// never fired at all.
//
// Observed live 2026-08-21: window opened 20:55:31, run-now at 20:56:08
// cleared the record, the window's off was edited to an already-past time,
// and nothing wrote to the row for 72 minutes while the music kept playing.
//
// Now it applies the window through the same volume-then-favourite path the
// reconcile uses and stamps last_applied as an open, exactly as a
// cron-driven open would. No wait, and the close's precondition is written
// rather than destroyed.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { uuidLike } from '@/lib/schemas'
import { logWarn } from '@/lib/log'
import { getSonosConfig, withFreshToken, sonosGetGroups, sonosSetGroupVolume, sonosLoadFavorite } from '@/lib/sonos/client'
import { mapGroups, resolveGroupIds, planAction } from '@/lib/sonos/groups'
import { dublinDayStr } from '@/lib/dublin-time'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'device_control')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const locationId = user.activeLocation?.id
  if (!locationId) return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })
  const { id } = await params
  if (!uuidLike.safeParse(id).success) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  const cfg = getSonosConfig()
  if (!cfg || cfg.error) {
    return NextResponse.json({ success: false, error: 'Sonos is not configured' }, { status: 503 })
  }

  const db = createServerClient()
  const { data: schedule, error } = await db
    .from('sonos_schedules')
    .select('*')
    .eq('id', id)
    .eq('location_id', locationId)
    .maybeSingle()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  if (!schedule) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  const nowMs = Date.now()
  // planAction is asked what should happen with last_applied ignored, which
  // is exactly what "run it now" means: re-apply the active window whether
  // or not it has already been applied.
  const plan = planAction({ ...schedule, last_applied: null }, nowMs, dublinDayStr(nowMs))
  if (!plan || plan.action !== 'open') {
    // Outside every window there is nothing to apply. Say so — the old
    // route returned success here and looked like it had worked.
    return NextResponse.json({ success: false, error: 'No window is active right now' }, { status: 409 })
  }

  const tok = await withFreshToken(db, locationId, cfg)
  if (!tok.ok) {
    return NextResponse.json({ success: false, error: 'Sonos is not connected', reason: tok.reason }, { status: 409 })
  }
  const groupsRes = await sonosGetGroups(tok.token, tok.householdId)
  if (!groupsRes.ok) {
    return NextResponse.json({ success: false, error: 'Sonos is not answering right now' }, { status: 502 })
  }
  const { groups } = mapGroups(groupsRes.body)
  const groupIds = resolveGroupIds(groups, schedule.player_ids)
  if (!groupIds.length) {
    return NextResponse.json({ success: false, error: 'None of this schedule’s speakers are online' }, { status: 409 })
  }

  let allOk = true
  for (const groupId of groupIds) {
    // Volume first: after loadFavorite the opening seconds would play at
    // the previous window's level.
    const v = await sonosSetGroupVolume(tok.token, groupId, plan.volume)
    if (!v.ok) { allOk = false; logWarn('sonos-run-now', 'setVolume failed', { groupId, statusCode: v.statusCode }); continue }
    const f = await sonosLoadFavorite(tok.token, groupId, plan.favoriteId)
    if (!f.ok) { allOk = false; logWarn('sonos-run-now', 'loadFavorite failed', { groupId, statusCode: f.statusCode }) }
  }

  if (!allOk) {
    // Do NOT stamp last_applied on a failure — an unapplied window is
    // retried by the next cron tick, which is what a transient failure
    // deserves. Stamping would cost the whole window.
    return NextResponse.json({ success: false, error: 'That did not work' }, { status: 502 })
  }

  const nowIso = new Date(nowMs).toISOString()
  const primary = groupIds[0]
  const group = groups.find((g) => g.id === primary)
  // window_on_at MUST stay a raw number. A string makes planAction's
  // equality never match, so every tick re-opens and loadFavorite restarts
  // the playlist every 60 seconds.
  const { error: upErr } = await db
    .from('sonos_schedules')
    .update({
      last_applied: { window_on_at: plan.windowOnAt, action: 'open', at: nowIso },
      last_state: { group_id: primary, playback_state: group?.playbackState || null, at: nowIso },
      updated_at: nowIso,
    })
    .eq('id', schedule.id)
    .eq('location_id', locationId)
  if (upErr) {
    logWarn('sonos-run-now', 'state write failed', { scheduleId: schedule.id, error: upErr.message })
    // The music IS playing; only the bookkeeping failed. Report success
    // with a warning rather than telling the operator it did not work.
    return NextResponse.json({ success: true, warning: 'applied, but the record did not save' })
  }

  return NextResponse.json({ success: true, groups: groupIds })
}
```

- [ ] **Step 2: Verify nothing else clears `last_applied`**

Run: `grep -rn "last_applied: null" src/`
Expected: no matches outside the `{ ...schedule, last_applied: null }` spread inside this route (which is an in-memory argument to `planAction`, not a database write). Confirm by reading each hit.

- [ ] **Step 3: Run the guard scripts and the suite**

Run: `npm run check:route-guards && npm run check:location-scoping && npm test`
Expected: guards PASS, tests PASS.

- [ ] **Step 4: Commit**

```bash
git add "src/app/api/sonos/schedules/[id]/run-now/route.js"
git commit -m "SONOSLIVE.6 — run now applies the window instead of stranding the close"
```

---

## Task 7: The control strip

**Files:**
- Create: `src/components/automations/SonosLiveControl.jsx`
- Modify: `src/components/automations/SonosScheduleClient.jsx`

- [ ] **Step 1: Read the existing component first**

Run: `grep -n "^function \|^export default function " src/components/automations/SonosScheduleClient.jsx`

You will see `ScheduleCard`, `ScheduleOverride`, `HouseholdPicker`, `UnreachableNotice` and friends. `SonosLiveControl` follows the same shape: a named function component rendered by `ScheduleCard`, taking what it needs as props. **Read `ScheduleOverride` in full** — it is the closest sibling (per-schedule, does its own fetches, has its own busy/error state) and sets the house style for this.

- [ ] **Step 2: Build the component**

Create `src/components/automations/SonosLiveControl.jsx` as a client component (`'use client'`) exporting `SonosLiveControl({ scheduleId, favorites, editable })`.

It must:

- **Poll `GET /api/sonos/now-playing?schedule_id=<id>` every 10 seconds** while mounted, and **stop while the tab is hidden** (`document.visibilityState`), resuming on `visibilitychange`. Clear the interval on unmount.
- Render the readout: playback state, current track name and artist, source name, and volume. When `track` is null show "Playing" with no track detail rather than blanks. When `live` is false, render the `reason` in plain words and hide the controls.
- Render controls, each `POST`ing to `/api/sonos/control` with `{schedule_id, action, value?}`:
  - **−** and **+** buttons → `volume_down` / `volume_up`. **Debounce to at most one request per 250ms, coalescing the pending presses into a single `value` step.** Sonos spike-arrests above 100 requests/second.
  - A volume **slider** → `set_volume`, committed **on release** (`onMouseUp` / `onTouchEnd` / `onKeyUp`), never on every input event.
  - **Play**, **Pause**, **Skip back**, **Skip forward** → the matching transport actions.
  - A **favourite picker** built from the `favorites` prop → `load_favorite`.
- When `fixedVolume` is true, disable the volume controls and say why ("these speakers are set to a fixed volume").
- On a failed action, **revert any optimistic state** and show the route's `error` message inline.
- Disable everything when `editable` is false, matching how `ScheduleCard` already gates its other controls.

Two parts are easy to get wrong, so here they are in full. Everything else is ordinary markup in the house style — follow `ScheduleOverride`.

**Visibility-aware polling.** A naive `setInterval` keeps hitting Sonos from every background tab an operator left open. Stop when hidden, refresh immediately on return so the readout is never stale on the first glance:

```jsx
const POLL_MS = 10000

function useNowPlaying(scheduleId) {
  const [state, setState] = useState(null)
  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/sonos/now-playing?schedule_id=${encodeURIComponent(scheduleId)}`)
      setState(await res.json())
    } catch {
      // A dropped poll is not worth surfacing — the next tick recovers.
    }
  }, [scheduleId])

  useEffect(() => {
    let timer = null
    const stop = () => { if (timer) { clearInterval(timer); timer = null } }
    const start = () => { if (!timer) timer = setInterval(load, POLL_MS) }

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') { stop() }
      else { load(); start() }   // refresh at once, then resume
    }

    load()
    start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility) }
  }, [load])

  return [state, load]
}
```

**Coalescing volume debounce.** Holding "+" must not fire one request per press. Accumulate the pending steps and send a single relative delta — which is also why the action takes a step size rather than a target:

```jsx
const VOLUME_STEP = 5
const DEBOUNCE_MS = 250

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
      if (!total) return   // equal ups and downs cancel out; send nothing
      send(total > 0 ? 'volume_up' : 'volume_down', Math.abs(total))
    }, DEBOUNCE_MS)
  }, [send])
}
```

Note `Math.abs` — direction lives in the action name, and `planLiveAction` reads a negative step as a size, not an instruction to invert. Sending a negative value with `volume_down` would still go down; passing the absolute value keeps the intent unambiguous at both ends.

Design constraints, all lint-enforced:
- `un1t-*` intent tokens only — copy tokens already used in `SonosScheduleClient.jsx`. A dead token name emits no CSS at all.
- Status chips are `bg-<c>-500/10 text-<c>-700`. Never `text-*-300/400/500` on a light surface.
- `type="button"` on every button.

- [ ] **Step 3: Render it from `ScheduleCard`**

In `src/components/automations/SonosScheduleClient.jsx`, import `SonosLiveControl` and render it inside `ScheduleCard`, directly below the name/enabled row and above the speakers section, passing `scheduleId={schedule.id}`, `favorites`, and `editable`.

- [ ] **Step 4: Verify**

Run: `npm run build`
Expected: exit 0. This is the gate that catches import failures; tests do not.

Run: `npm run lint && npm run check:guardrails`
Expected: 0 errors, guardrails clean.

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/automations/SonosLiveControl.jsx src/components/automations/SonosScheduleClient.jsx
git commit -m "SONOSLIVE.7 — the live control strip"
```

---

## Task 8: Register the routes in the OpenAPI spec

`CLAUDE.md` requires every new route to be registered in `src/lib/openapi.js` so `/api/openapi.json` and `/api-docs` stay in sync.

**Files:**
- Modify: `src/lib/openapi.js`

- [ ] **Step 1: Read how the existing Sonos routes are registered**

Run: `grep -n "sonos" src/lib/openapi.js | head -20`

The six existing Sonos routes are registered under the `Automations` tag with `CookieAuth`. Match that idiom exactly — schemas are hand-defined in this file (it never imports from `src/app/api`), tags and security identical.

- [ ] **Step 2: Register the two new routes**

Add:

- `POST /api/sonos/control` — body `{schedule_id, action, value?}` with `action` enumerated as the eight values from `ACTIONS`. Responses: 200 `{success, groups}`; 400 invalid; 401; 403; 404 unknown schedule; 409 not connected / no speakers online / fixed volume / regrouped / nothing loaded; 429 rate limited; 502 Sonos failed; 503 not configured.
- `GET /api/sonos/now-playing` — query `schedule_id`. Responses: 200, either `{success, live: false, reason}` or `{success, live: true, groupId, playbackState, volume, muted, fixedVolume, volumeFailed, track, source}`; 401; 403; 404.

- [ ] **Step 3: Update the run-now description**

Its current description says it clears `last_applied` for the next tick. It now applies the window immediately. Update the text and add the 409 "No window is active right now" response.

- [ ] **Step 4: Verify the spec still builds**

Run: `npx vitest run src/lib/openapi.test.js`
Expected: PASS.

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/openapi.js
git commit -m "SONOSLIVE.8 — register the live control routes"
```

---

## Verification gates

Before opening the PR:

```bash
npm test && npm run lint && npm run build
npm run check:route-guards && npm run check:location-scoping && npm run check:guardrails && npm run check:secrets && npm run check:rls-restrictive
```

## Manual verification (needs a live household)

- [ ] Volume − and + change the room within about a second
- [ ] Two rapid + presses raise it by the sum, not by one step (relative volume, not absolute)
- [ ] The slider fires **once** on release, not continuously while dragging
- [ ] Pause stops the room; play resumes it
- [ ] Switching favourite changes what plays
- [ ] The readout updates within ~10s and stops polling when the tab is hidden
- [ ] **Run now inside a window** applies immediately and stamps `last_applied` — check the row shows `{action:'open'}` with a numeric `window_on_at`
- [ ] **Run now outside a window** says "No window is active right now" instead of silently succeeding
- [ ] After a live pause, the scheduled close still fires at the window's end (pausing an already-paused group, which is benign)

## Out of scope

Grouping and ungrouping speakers, per-player volume, queue manipulation beyond skip, seek, play-mode toggles, audio-clip announcements — and the entire mobile surface, which is its own plan.
