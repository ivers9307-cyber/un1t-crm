# Shelly Device Control — Backend (PR 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the dormant backend of the per-location Shelly integration — tz-aware schedule engine, never-throw cloud client, exactly-once planner, energy roll, per-location reconcile cron, and the three tables — so PR 2 (routes + page) can be built on it and Stillorgan can go live.

**Architecture:** A per-minute Vercel cron loads every `shelly_connections` row (the row IS the config; zero rows = dormant), groups them by auth-key fingerprint (one Shelly account = one 1 req/s budget), and per location: reads device status in batches of 10, refreshes `last_state` and the daily energy roll, plans boundary-exactly-once on/off actions (plus two-way manual overrides) via `planDeviceAction`, and writes them with at most one `set/groups` call per direction. All I/O is injected so every module is unit-tested with fakes.

**Tech Stack:** Next.js 16 App Router (JS, not TS), Supabase (service-role in cron/routes; RLS for browser reads), vitest, Node 24 (`Map.groupBy` available), Intl time-zone maths.

**Spec:** `docs/superpowers/specs/2026-08-22-shelly-device-control-design.md`

---

## Conventions this codebase already has — follow them

- **Tests are colocated**: `src/lib/shelly/client.js` → `src/lib/shelly/client.test.js`. Run one file with `npx vitest run <path>`; everything with `npm test`.
- **Run time-zone-sensitive suites under TWO zones**: `TZ=Europe/Dublin npx vitest run <paths>` and `TZ=America/New_York npx vitest run <paths>`. Both must pass.
- **Never-throw I/O clients** return tagged results (`{ ok, … }`) and never reject — copy the shape of `src/lib/sonos/client.js`.
- **Every Supabase write destructures `error`** and judges it (`const { error } = await db.from(...).update(...)`). The guardrail `no-unchecked-supabase-write` is armed for this area in Task 9, so a bare write fails `npm run check:guardrails`.
- **Secrets never appear in logs or thrown errors.** The auth key rides in the query string, so never log a URL.
- **Logging**: `import { logWarn, logError } from '@/lib/log'` — signature `(module, message, meta)`. Tests `vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))`.
- **Migrations are forward-only**, numbered; latest on main is `561_…`, so this plan uses **562** and **563**. Apply via Supabase MCP against `iyvtbjjxdggiadzwwvdj` (confirm with `list_projects`; NOT the sentinel project). **563 is applied ONLY after the deploy** (health-check 503s on a stale heartbeat row).
- **RLS**: single SELECT policy per table + per-command RESTRICTIVE denies. Never `RESTRICTIVE … FOR ALL`.
- **Commit style**: `SHELLY.N — lowercase summary`. Stage explicit files only (never `git add -A`).
- **`src/lib/dublin-time.js` must NOT gain exports** — `tests/shared-pair-sync.test.js` pins its export list. New time helpers go in `src/lib/tz-time.js`.

## File structure

**Create:**

| File | Responsibility |
|---|---|
| `src/lib/tz-time.js` (+ `.test.js`) | IANA-zone wall-clock maths: `dayStrInTz`, `wallMsInTz`, `dayStartMsInTz`, `nextLocalMidnightMs`, `resolveTz`. |
| `src/lib/shelly/client.js` (+ test) | Host normalisation, key fingerprint/hint, secret redaction, never-throw paced v2/v1 client. |
| `src/lib/shelly/status.js` (+ test) | Pure normalisers for v2 `get` items and v1 `all_status`; `stateFromReading`, `stateChanged`, `groupId`. |
| `src/lib/shelly/plan.js` (+ test) | Pure `planDeviceAction` — the exactly-once state machine. |
| `src/lib/shelly/energy.js` (+ test) | Pure `rollDailyEnergy`. |
| `src/lib/shelly/connections.js` (+ test) | Fingerprint clash classification, connection loaders, `publicConnectionView`, `probeConnection`. |
| `src/lib/shelly/reconcile.js` (+ test) | Orchestration: `runShellyReconcile`, `reconcileLocation`, `refreshLocationState`, `runNowForDevice`, `loadTodayOccurrences`. |
| `src/app/api/cron/shelly-reconcile/route.js` | Thin CRON_SECRET wrapper. |
| `supabase/migrations/562_shelly_control_integration.sql` | Three tables + RLS. Apply any time. |
| `supabase/migrations/563_shelly_reconcile_heartbeat.sql` | Heartbeat row. **Apply only after the deploy.** |

**Modify:** `src/lib/schedule/desired-state.js` (+ test — additive `tz` param), `vercel.json` (cron entry), `eslint.guardrails.config.mjs` (arm the area), `docs/CHANGELOG.md`, `docs/architecture/INTEGRATIONS.md`.

---

## Task 1: `src/lib/tz-time.js` — zone-aware wall-clock helpers

The engine's private `dublinWallMs` corrects by minute-of-day only, which is a whole day wrong for negative-offset zones (a New York read-back lands on the previous date). This module corrects from the full date-time read-back; Dublin results are bit-identical.

**Files:**
- Create: `src/lib/tz-time.js`
- Test: `src/lib/tz-time.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// src/lib/tz-time.test.js
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_TZ, isValidTz, resolveTz, dayStrInTz, wallMsInTz, dayStartMsInTz, nextLocalMidnightMs,
} from './tz-time'
import { dublinDayStr } from './dublin-time'

const NY = 'America/New_York'

describe('resolveTz', () => {
  it('falls back to Dublin for null, blank and garbage', () => {
    expect(resolveTz(null)).toBe(DEFAULT_TZ)
    expect(resolveTz('')).toBe(DEFAULT_TZ)
    expect(resolveTz('Mars/Olympus')).toBe(DEFAULT_TZ)
  })
  it('keeps a valid zone', () => {
    expect(resolveTz(NY)).toBe(NY)
    expect(isValidTz(NY)).toBe(true)
    expect(isValidTz('nope')).toBe(false)
  })
})

describe('dayStrInTz', () => {
  it('matches dublinDayStr for Dublin across a BST evening and both DST transitions', () => {
    for (const iso of ['2026-07-06T22:30:00Z', '2026-07-06T23:30:00Z', '2026-03-29T00:30:00Z', '2026-10-25T01:30:00Z']) {
      expect(dayStrInTz(Date.parse(iso))).toBe(dublinDayStr(Date.parse(iso)))
    }
  })
  it('keys a late US evening to the local day, not the UTC day', () => {
    expect(dayStrInTz(Date.parse('2026-07-07T03:30:00Z'), NY)).toBe('2026-07-06')
  })
})

describe('wallMsInTz', () => {
  it('resolves a Dublin IST wall-clock exactly (UTC+1)', () => {
    expect(wallMsInTz('2026-07-06', '07:00')).toBe(Date.parse('2026-07-06T07:00:00+01:00'))
  })
  it('resolves a Dublin GMT wall-clock exactly (UTC+0)', () => {
    expect(wallMsInTz('2026-01-12', '07:00')).toBe(Date.parse('2026-01-12T07:00:00+00:00'))
  })
  it('is a whole day right for a negative-offset zone (the old minute-of-day bug)', () => {
    expect(wallMsInTz('2026-07-06', '07:00', NY)).toBe(Date.parse('2026-07-06T07:00:00-04:00'))
    expect(wallMsInTz('2026-07-06', '00:00', NY)).toBe(Date.parse('2026-07-06T00:00:00-04:00'))
  })
  it('handles the New York spring-forward day', () => {
    expect(wallMsInTz('2026-03-08', '07:00', NY)).toBe(Date.parse('2026-03-08T07:00:00-04:00'))
  })
  it('returns null for a malformed time', () => {
    expect(wallMsInTz('2026-07-06', '7:00')).toBe(null)
    expect(wallMsInTz('2026-07-06', undefined)).toBe(null)
  })
})

describe('dayStartMsInTz / nextLocalMidnightMs', () => {
  it('dayStart is 00:00 local', () => {
    expect(dayStartMsInTz('2026-07-06', NY)).toBe(Date.parse('2026-07-06T00:00:00-04:00'))
  })
  it('next midnight on a 23h Dublin day (spring forward 2026-03-29)', () => {
    const at = Date.parse('2026-03-29T03:00:00+01:00')
    expect(nextLocalMidnightMs(at, 'Europe/Dublin')).toBe(Date.parse('2026-03-30T00:00:00+01:00'))
  })
  it('next midnight on a 25h Dublin day (fall back 2026-10-25)', () => {
    const at = Date.parse('2026-10-25T12:00:00+00:00')
    expect(nextLocalMidnightMs(at, 'Europe/Dublin')).toBe(Date.parse('2026-10-26T00:00:00+00:00'))
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/tz-time.test.js`
Expected: FAIL — `Failed to resolve import "./tz-time"`.

- [ ] **Step 3: Write the module**

```js
// src/lib/tz-time.js
// SHELLY.1 — wall-clock maths for an arbitrary IANA zone. Lives here, NOT in
// dublin-time.js: that file's export list is pinned by
// tests/shared-pair-sync.test.js (mode `diverged`), so it cannot grow.
//
// The guess-and-correct technique is the one dublin-time's dublinDayStartMs
// uses, with one fix: the correction is computed from the FULL date+time
// read-back, not minute-of-day. Minute-of-day alone is a whole day wrong for
// any negative-offset zone, whose read-back lands on the previous calendar
// date. One pass is exact for any zone with a ±1h DST shift; inside the
// transition hour it resolves to the same deterministic nearby instant the
// Dublin engine already accepts (nonexistent → earlier, ambiguous → later).

import { addDaysISO } from '@/lib/dublin-time'

export const DEFAULT_TZ = 'Europe/Dublin'

const _fmt = new Map()
const _valid = new Map()

function partsFmt(tz) {
  if (!_fmt.has(tz)) {
    _fmt.set(tz, new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }))
  }
  return _fmt.get(tz)
}

export function isValidTz(tz) {
  if (typeof tz !== 'string' || !tz.trim()) return false
  if (!_valid.has(tz)) {
    try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); _valid.set(tz, true) }
    catch { _valid.set(tz, false) }
  }
  return _valid.get(tz)
}

// locations.timezone is nullable free text; an invalid value must not throw
// inside a cron. Callers log the fallback once per location if they care.
export function resolveTz(tz) {
  return isValidTz(tz) ? tz : DEFAULT_TZ
}

function readParts(ms, tz) {
  const p = {}
  for (const { type, value } of partsFmt(tz).formatToParts(new Date(ms))) p[type] = value
  const hour = p.hour === '24' ? 0 : Number(p.hour)
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: hour, mi: Number(p.minute) }
}

// Wall-clock in `tz` at `ms`, re-encoded as if it were UTC ("naive" ms).
function naiveWallMs(ms, tz) {
  const { y, mo, d, h, mi } = readParts(ms, tz)
  return Date.UTC(y, mo - 1, d, h, mi)
}

// 'YYYY-MM-DD' of the instant in `tz`. Intl parts, never toISOString().slice.
export function dayStrInTz(instant = Date.now(), tz = DEFAULT_TZ) {
  const ms = instant instanceof Date ? instant.getTime() : Number(instant)
  const { y, mo, d } = readParts(ms, tz)
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

// UTC ms of wall-clock HH:MM on calendar date `dateStr` in `tz`; null on a bad HH:MM.
export function wallMsInTz(dateStr, hhmm, tz = DEFAULT_TZ) {
  const m = String(hhmm || '').match(/^(\d{2}):(\d{2})$/)
  if (!m) return null
  const [y, mo, d] = String(dateStr).split('-').map(Number)
  if (![y, mo, d].every(Number.isFinite)) return null
  const want = Date.UTC(y, mo - 1, d, Number(m[1]), Number(m[2]))
  return want - (naiveWallMs(want, tz) - want)
}

export function dayStartMsInTz(dateStr, tz = DEFAULT_TZ) {
  return wallMsInTz(dateStr, '00:00', tz)
}

// Next local midnight strictly after `instant` — the default expiry of a manual override.
export function nextLocalMidnightMs(instant = Date.now(), tz = DEFAULT_TZ) {
  return dayStartMsInTz(addDaysISO(dayStrInTz(instant, tz), 1), tz)
}
```

- [ ] **Step 4: Run the tests under both zones**

Run: `TZ=Europe/Dublin npx vitest run src/lib/tz-time.test.js && TZ=America/New_York npx vitest run src/lib/tz-time.test.js`
Expected: PASS both times (12 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/tz-time.js src/lib/tz-time.test.js
git commit -m "SHELLY.1 — tz-time: zone-aware wall-clock helpers, correcting from the full date-time read-back"
```

---

## Task 2: Give the schedule engine an optional `tz`

Additive and behaviour-preserving: every existing assertion in `desired-state.test.js` must stay green untouched. The Sonos planner (`src/lib/sonos/groups.js`) keeps calling with no `tz` and gets Dublin.

**Files:**
- Modify: `src/lib/schedule/desired-state.js`
- Test: `src/lib/schedule/desired-state.test.js` (append only)

- [ ] **Step 1: Append the failing tests**

```js
// append to src/lib/schedule/desired-state.test.js
describe('tz parameter (SHELLY.2)', () => {
  const NY = 'America/New_York'
  const nyDevice = {
    enabled: true, schedule_mode: 'fixed',
    fixed_windows: [{ days: [1, 2, 3, 4, 5], on: '07:00', off: '21:30' }],
    class_rule: {}, override: null,
  }
  it('explicit Dublin equals the default', () => {
    expect(resolveDayWindows(fixedDevice, DAY, [], 'Europe/Dublin')).toEqual(resolveDayWindows(fixedDevice, DAY, []))
  })
  it('resolves a New York window to -04:00 instants (day-wrap regression)', () => {
    const w = resolveDayWindows(nyDevice, DAY, [], NY)
    expect(w[0].on_at).toBe(Date.parse(`${DAY}T07:00:00-04:00`))
    expect(w[0].off_at).toBe(Date.parse(`${DAY}T21:30:00-04:00`))
  })
  it('overnight Sat 22:00 → Sun 03:00 across NY spring-forward is 5 wall-hours but 4 real hours', () => {
    const night = { ...nyDevice, fixed_windows: [{ days: [6], on: '22:00', off: '03:00' }] }
    const w = resolveDayWindows(night, '2026-03-07', [], NY)
    expect(w[0].on_at).toBe(Date.parse('2026-03-07T22:00:00-05:00'))
    expect(w[0].off_at).toBe(Date.parse('2026-03-08T03:00:00-04:00')) // 03:00 EDT — the hour 02:00–03:00 never exists
    expect(w[0].off_at - w[0].on_at).toBe(4 * 3600 * 1000)
  })
  it('serves yesterday\'s overnight tail after NY midnight', () => {
    const night = { ...nyDevice, fixed_windows: [{ days: [6], on: '22:00', off: '02:00' }] }
    const sunday0030 = Date.parse('2026-07-12T00:30:00-04:00')
    expect(desiredState(night, sunday0030, '2026-07-12', [], NY)).toBe('on')
  })
  it('class mode is unaffected by tz (occurrences are UTC instants)', () => {
    const w = resolveDayWindows(classDevice, DAY, [occ('06:00', '06:45')], NY)
    expect(w[0].on_at).toBe(T('06:00') - 15 * 60 * 1000)
  })
})
```

(Why 4 real hours: New York jumps 02:00 EST → 03:00 EDT on 2026-03-08, so a 22:00→03:00 wall-clock window spans five wall-hours but only four real ones. The old minute-of-day correction would have put both boundaries a day out.)

- [ ] **Step 2: Run to verify the new block fails**

Run: `npx vitest run src/lib/schedule/desired-state.test.js`
Expected: the 5 new tests FAIL (Dublin instants returned for NY); every pre-existing test PASSES.

- [ ] **Step 3: Thread `tz` through the engine**

In `src/lib/schedule/desired-state.js`:
1. Replace the import line and delete the private `DUBLIN_TZ`, `_partsFmt` and `dublinWallMs` definitions:

```js
import { addDaysISO } from '@/lib/dublin-time'
import { wallMsInTz, DEFAULT_TZ } from '@/lib/tz-time'
```

2. Change the three signatures and every wall-clock call:

```js
export function resolveDayWindows(device, dateStr, occurrences = [], tz = DEFAULT_TZ) {
  // … unchanged until the fixed branch:
      const onAt = wallMsInTz(dateStr, w.on, tz)
      let offAt = wallMsInTz(dateStr, w.off, tz)
      if (onAt == null || offAt == null) continue
      if (offAt <= onAt) offAt = wallMsInTz(addDaysISO(dateStr, 1), w.off, tz)
  // … rest unchanged
}

export function resolveServeWindows(device, dateStr, occurrences = [], tz = DEFAULT_TZ) {
  if (!device || !device.enabled) return []
  const today = resolveDayWindows(device, dateStr, occurrences, tz)
  if (device.schedule_mode !== 'fixed') return today
  const dayStartMs = wallMsInTz(dateStr, '00:00', tz)
  const tails = resolveDayWindows(device, addDaysISO(dateStr, -1), [], tz)
    .filter(w => w.off_at > dayStartMs)
  if (!tails.length) return today
  return [...tails, ...today].sort((a, b) => a.on_at - b.on_at)
}

export function desiredState(device, nowMs, dateStr, occurrences = [], tz = DEFAULT_TZ) {
  // … unchanged until:
  const windows = resolveServeWindows(device, dateStr, occurrences, tz)
```

3. Update the header comment: "TZ-safe via dublin-time's Intl-based day-start math" → "zone-aware via src/lib/tz-time.js (default Europe/Dublin; callers pass locations.timezone)".

- [ ] **Step 4: Run the engine suite under both zones, plus the Sonos planner**

Run: `TZ=Europe/Dublin npx vitest run src/lib/schedule src/lib/sonos/groups.test.js && TZ=America/New_York npx vitest run src/lib/schedule src/lib/sonos/groups.test.js`
Expected: PASS — all pre-existing engine tests unchanged, 5 new, Sonos planner green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/schedule/desired-state.js src/lib/schedule/desired-state.test.js
git commit -m "SHELLY.2 — schedule engine takes an optional IANA zone, Dublin by default"
```

---

## Task 3: `src/lib/shelly/client.js` — host/key helpers and the never-throw paced client

**Files:**
- Create: `src/lib/shelly/client.js`
- Test: `src/lib/shelly/client.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// src/lib/shelly/client.test.js
import { describe, it, expect, vi } from 'vitest'
import {
  normaliseShellyHost, fingerprintAuthKey, keyHint, redactSecret,
  classifyV2, classifyV1, parseGroupsResult, createShellyClient,
  MIN_GAP_MS, RETRY_429_AFTER_MS,
} from './client'

const KEY = 'MTIzNDU2Nzg5MGFiY2RlZg-SECRET-KEY-VALUE'
const conn = { host: 'shelly-103-eu.shelly.cloud', auth_key: KEY }

describe('normaliseShellyHost', () => {
  it('accepts a bare host, a pasted URL, uppercase and whitespace', () => {
    for (const input of ['shelly-103-eu.shelly.cloud', ' https://Shelly-103-EU.shelly.cloud/ ', 'https://shelly-103-eu.shelly.cloud:443/device/status?x=1']) {
      expect(normaliseShellyHost(input)).toEqual({ ok: true, host: 'shelly-103-eu.shelly.cloud' })
    }
  })
  it('rejects anything that is not the account server (SSRF guard)', () => {
    for (const bad of ['shelly-1.shelly.cloud.evil.com', 'evil.com/?h=shelly-1.shelly.cloud', 'localhost', '10.0.0.1', 'api.shelly.cloud', '']) {
      expect(normaliseShellyHost(bad).ok).toBe(false)
    }
  })
  it('drops userinfo, port and path — only the hostname survives', () => {
    expect(normaliseShellyHost('https://user:pw@shelly-1-eu.shelly.cloud:8443/x')).toEqual({ ok: true, host: 'shelly-1-eu.shelly.cloud' })
  })
  it('explains what it wanted without echoing the input back', () => {
    const r = normaliseShellyHost('evil.com')
    expect(r.error).toMatch(/shelly-<region>\.shelly\.cloud/)
    expect(r.error).not.toContain('evil.com')
  })
})

describe('fingerprintAuthKey / keyHint / redactSecret', () => {
  it('fingerprint is 64 hex and stable', () => {
    expect(fingerprintAuthKey(KEY)).toMatch(/^[0-9a-f]{64}$/)
    expect(fingerprintAuthKey(KEY)).toBe(fingerprintAuthKey(KEY))
    expect(fingerprintAuthKey(KEY)).not.toBe(fingerprintAuthKey(KEY + 'x'))
  })
  it('hint is the last four characters', () => {
    expect(keyHint(KEY)).toBe('ALUE')
    expect(keyHint('ab')).toBe('')
  })
  it('redactSecret strips the key out of a message that embeds a URL', () => {
    const e = new Error(`fetch failed for https://x/v2?auth_key=${KEY}`)
    const r = redactSecret(e, KEY)
    expect(r.message).not.toContain(KEY)
    expect(r.message).toContain('[redacted]')
    expect(r.name).toBe('Error')
  })
})

describe('classifiers', () => {
  it('v2: 401/403 and a 2xx UNAUTHORIZED body are auth; 429 is rate_limited', () => {
    expect(classifyV2(401, null)).toBe('auth')
    expect(classifyV2(403, null)).toBe('auth')
    expect(classifyV2(200, { error: 'UNAUTHORIZED' })).toBe('auth')
    expect(classifyV2(429, null)).toBe('rate_limited')
    expect(classifyV2(200, {})).toBe('ok')
    expect(classifyV2(500, null)).toBe('http')
  })
  it('v1: isok:false with invalid_token is auth', () => {
    expect(classifyV1(200, { isok: false, errors: { invalid_token: 'bad' } })).toBe('auth')
    expect(classifyV1(200, { isok: true, data: {} })).toBe('ok')
    expect(classifyV1(200, { isok: false, errors: { other: 'x' } })).toBe('http')
  })
  it('parseGroupsResult maps failedCommands and treats empty bodies as all-ok', () => {
    expect(parseGroupsResult({ failedCommands: { a_0: 'DEVICE_OFFLINE' } })).toEqual({ failed: { a_0: 'DEVICE_OFFLINE' } })
    expect(parseGroupsResult({})).toEqual({ failed: {} })
    expect(parseGroupsResult(null)).toEqual({ failed: {} })
  })
})

function fetchStub(responses) {
  const calls = []
  const fetchImpl = vi.fn(async (url, init) => {
    calls.push({ url: String(url), init })
    const r = responses.shift() || { status: 200, body: '' }
    if (r.reject) throw new Error('network down')
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.body ?? '' }
  })
  return { fetchImpl, calls }
}

function clockAndSleep(start = 1_000_000) {
  let t = start
  const slept = []
  return {
    now: () => t,
    sleep: vi.fn(async (ms) => { slept.push(ms); t += ms }),
    advance: (ms) => { t += ms },
    slept,
  }
}

describe('createShellyClient', () => {
  it('puts auth_key in the query string, never in the JSON body, and never in results', async () => {
    const { fetchImpl, calls } = fetchStub([{ status: 200, body: JSON.stringify([{ id: 'a8032abe41fc', online: 1 }]) }])
    const c = createShellyClient(conn, { fetchImpl, ...clockAndSleep() })
    const res = await c.get(['a8032abe41fc'])
    expect(res.ok).toBe(true)
    expect(calls[0].url).toBe(`https://shelly-103-eu.shelly.cloud/v2/devices/api/get?auth_key=${encodeURIComponent(KEY)}`)
    expect(calls[0].init.body).not.toContain(KEY)
    expect(JSON.stringify(res)).not.toContain(KEY)
  })

  it('paces consecutive calls at least MIN_GAP_MS apart, and not when the gap already passed', async () => {
    const { fetchImpl } = fetchStub([{ status: 200, body: '[]' }, { status: 200, body: '[]' }, { status: 200, body: '[]' }])
    const clk = clockAndSleep()
    const c = createShellyClient(conn, { fetchImpl, now: clk.now, sleep: clk.sleep })
    await c.get(['a'])
    await c.get(['b'])                       // immediately after → must sleep
    expect(clk.slept[0]).toBeGreaterThanOrEqual(MIN_GAP_MS - 1)
    clk.advance(5000)
    await c.get(['c'])                       // 5s later → no sleep
    expect(clk.slept).toHaveLength(1)
  })

  it('retries a 429 exactly once after RETRY_429_AFTER_MS, then gives up tagged', async () => {
    const { fetchImpl, calls } = fetchStub([{ status: 429, body: '' }, { status: 429, body: '' }])
    const clk = clockAndSleep()
    const c = createShellyClient(conn, { fetchImpl, now: clk.now, sleep: clk.sleep })
    const res = await c.get(['a'])
    expect(calls).toHaveLength(2)
    expect(clk.slept).toContain(RETRY_429_AFTER_MS)
    expect(res).toMatchObject({ ok: false, kind: 'rate_limited', retried: true })
  })

  it('maps 401 to auth and a network rejection to network without throwing', async () => {
    const a = createShellyClient(conn, { fetchImpl: fetchStub([{ status: 401, body: '' }]).fetchImpl, ...clockAndSleep() })
    expect(await a.get(['a'])).toMatchObject({ ok: false, kind: 'auth', statusCode: 401 })
    const b = createShellyClient(conn, { fetchImpl: fetchStub([{ reject: true }]).fetchImpl, ...clockAndSleep() })
    expect(await b.get(['a'])).toMatchObject({ ok: false, kind: 'network', statusCode: 0 })
  })

  it('setSwitch: a bare 200 with an empty body is success; a 2xx DEVICE_OFFLINE body is a device failure', async () => {
    const { fetchImpl, calls } = fetchStub([{ status: 200, body: '' }, { status: 200, body: JSON.stringify({ error: 'DEVICE_OFFLINE' }) }])
    const c = createShellyClient(conn, { fetchImpl, ...clockAndSleep() })
    expect(await c.setSwitch('a8032abe41fc', 1, true)).toMatchObject({ ok: true })
    expect(JSON.parse(calls[0].init.body)).toEqual({ id: 'a8032abe41fc', channel: 1, on: true })
    expect(await c.setSwitch('a8032abe41fc', 0, false)).toMatchObject({ ok: false, kind: 'device', code: 'DEVICE_OFFLINE' })
  })

  it('setGroups sends the documented body and surfaces failedCommands', async () => {
    const { fetchImpl, calls } = fetchStub([{ status: 200, body: JSON.stringify({ failedCommands: { b_0: 'DEVICE_OFFLINE' } }) }])
    const c = createShellyClient(conn, { fetchImpl, ...clockAndSleep() })
    const res = await c.setGroups(['a_0', 'b_0'], false)
    expect(JSON.parse(calls[0].init.body)).toEqual({ switch: { ids: ['a_0', 'b_0'], command: { on: false } } })
    expect(res).toMatchObject({ ok: true, failed: { b_0: 'DEVICE_OFFLINE' } })
  })

  it('allStatus is the v1 form-encoded call and classifies invalid_token as auth', async () => {
    const { fetchImpl, calls } = fetchStub([{ status: 200, body: JSON.stringify({ isok: false, errors: { invalid_token: 'x' } }) }])
    const c = createShellyClient(conn, { fetchImpl, ...clockAndSleep() })
    const res = await c.allStatus()
    expect(calls[0].url).toBe('https://shelly-103-eu.shelly.cloud/device/all_status')
    expect(calls[0].init.headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(calls[0].init.body).toContain('show_info=true')
    expect(calls[0].init.body).toContain('no_shared=true')
    expect(res).toMatchObject({ ok: false, kind: 'auth' })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/shelly/client.test.js`
Expected: FAIL — `Failed to resolve import "./client"`.

- [ ] **Step 3: Write the module**

```js
// src/lib/shelly/client.js
// SHELLY.3 — Shelly Cloud Control API client. Never throws; every result is
// tagged. The auth key rides in the QUERY STRING (that is Shelly's API), so
// nothing in this file ever logs a URL, and no result carries one.
//
// Rate limit is 1 request/second PER ACCOUNT. Pacing and the single 429
// retry live in one place here so the cron and the staff routes cannot
// disagree. Same-account studios share one budget — the reconcile
// serialises them (see reconcile.js); this client only paces itself.

import { createHash } from 'node:crypto'

export const REQUEST_TIMEOUT_MS = 8000
export const MIN_GAP_MS = 1000
export const RETRY_429_AFTER_MS = 1100
const USER_AGENT = 'un1t-crm/1.0 (+https://crm.repset.ie)'
const HOST_RE = /^shelly-[a-z0-9-]+\.shelly\.cloud$/

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Operator-supplied and server-fetched: an SSRF surface. Hostname only,
// lowercased, and it must be an account server. Accepts a pasted URL.
export function normaliseShellyHost(input) {
  let s = String(input ?? '').trim().toLowerCase()
  const wanted = 'Enter your account server from the Shelly app, e.g. shelly-<region>.shelly.cloud'
  if (!s) return { ok: false, error: wanted }
  if (!/^[a-z]+:\/\//.test(s)) s = 'https://' + s
  let host
  try { host = new URL(s).hostname } catch { return { ok: false, error: wanted } }
  if (!HOST_RE.test(host)) return { ok: false, error: wanted }
  return { ok: true, host }
}

export function fingerprintAuthKey(key) {
  return createHash('sha256').update(String(key), 'utf8').digest('hex')
}

export function keyHint(key) {
  const s = String(key || '')
  return s.length >= 4 ? s.slice(-4) : ''
}

export function redactSecret(err, secret) {
  const name = err?.name || 'Error'
  let message = String(err?.message ?? err ?? '')
  if (secret) message = message.split(secret).join('[redacted]')
  return { name, message }
}

export function classifyV2(statusCode, body) {
  if (statusCode === 401 || statusCode === 403) return 'auth'
  if (statusCode === 429) return 'rate_limited'
  if (statusCode === 0) return 'network'
  if (statusCode >= 200 && statusCode < 300) {
    if (body && typeof body.error === 'string' && /UNAUTHORI[SZ]ED|INVALID_TOKEN/i.test(body.error)) return 'auth'
    return 'ok'
  }
  return 'http'
}

export function classifyV1(statusCode, body) {
  if (statusCode === 401 || statusCode === 403) return 'auth'
  if (statusCode === 429) return 'rate_limited'
  if (statusCode === 0) return 'network'
  if (statusCode >= 200 && statusCode < 300) {
    if (body && body.isok === false) {
      return body.errors && Object.prototype.hasOwnProperty.call(body.errors, 'invalid_token') ? 'auth' : 'http'
    }
    return 'ok'
  }
  return 'http'
}

export function parseGroupsResult(body) {
  const fc = body && typeof body === 'object' && body.failedCommands && typeof body.failedCommands === 'object'
    ? body.failedCommands : {}
  return { failed: { ...fc } }
}

export function createShellyClient(conn, { fetchImpl = fetch, sleep = realSleep, now = Date.now, minGapMs = MIN_GAP_MS } = {}) {
  const host = String(conn?.host || '')
  const key = String(conn?.auth_key || '')
  let lastCallAt = -Infinity

  async function once(path, body, { v1 = false } = {}) {
    const url = v1
      ? `https://${host}${path}`
      : `https://${host}${path}?auth_key=${encodeURIComponent(key)}`
    const init = v1
      ? { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': USER_AGENT },
          body: new URLSearchParams({ auth_key: key, ...body }).toString() }
      : { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT },
          body: JSON.stringify(body ?? {}) }
    let res
    try {
      res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), cache: 'no-store' })
    } catch {
      return { ok: false, kind: 'network', statusCode: 0, body: null }
    } finally {
      lastCallAt = now()
    }
    const text = await res.text().catch(() => '')
    let parsed = null
    if (text) { try { parsed = JSON.parse(text) } catch { parsed = null } }   // bare-200 bodies are fine
    const kind = v1 ? classifyV1(res.status, parsed) : classifyV2(res.status, parsed)
    if (kind === 'ok') return { ok: true, statusCode: res.status, body: parsed }
    return { ok: false, kind, statusCode: res.status, body: parsed }
  }

  async function call(path, body, opts) {
    const wait = minGapMs - (now() - lastCallAt)
    if (wait > 0) await sleep(wait)
    let res = await once(path, body, opts)
    if (!res.ok && res.kind === 'rate_limited') {
      await sleep(RETRY_429_AFTER_MS)
      res = { ...(await once(path, body, opts)), retried: true }
    }
    return res
  }

  return {
    // ids ≤ 10 per Shelly's limit — callers batch, the client slices defensively.
    get: (ids, { select = ['status', 'settings'] } = {}) =>
      call('/v2/devices/api/get', { ids: (ids || []).slice(0, 10), select }),
    setSwitch: async (deviceId, channel, on) => {
      const res = await call('/v2/devices/api/set/switch', { id: deviceId, channel: Number(channel) || 0, on: !!on })
      if (res.ok && res.body && typeof res.body.error === 'string') {
        return { ok: false, kind: 'device', code: res.body.error, statusCode: res.statusCode }
      }
      return res
    },
    setGroups: async (groupIds, on) => {
      const res = await call('/v2/devices/api/set/groups', { switch: { ids: groupIds, command: { on: !!on } } })
      if (!res.ok) return res
      return { ok: true, statusCode: res.statusCode, ...parseGroupsResult(res.body) }
    },
    allStatus: () => call('/device/all_status', { show_info: 'true', no_shared: 'true' }, { v1: true }),
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/shelly/client.test.js`
Expected: PASS (16 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/shelly/client.js src/lib/shelly/client.test.js
git commit -m "SHELLY.3 — never-throw paced Shelly Cloud client; host SSRF guard, key fingerprint and redaction"
```

---
## Task 4: `src/lib/shelly/status.js` — pure normalisers

**Files:**
- Create: `src/lib/shelly/status.js`
- Test: `src/lib/shelly/status.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// src/lib/shelly/status.test.js
import { describe, it, expect } from 'vitest'
import { normaliseGetItems, normaliseAllStatus, stateFromReading, stateChanged, groupId } from './status'

const plugS = {
  id: 'A8032ABE41FC', code: 'SNPL-00112EU', gen: 2, online: 1,
  settings: { sys: { device: { name: 'Treadmill 1' } } },
  status: { 'switch:0': { id: 0, output: true, apower: 412.3, voltage: 231, current: 1.8, aenergy: { total: 11679.5, by_minute: [1, 2, 3] }, temperature: { tC: 41.2 }, source: 'WS_in' } },
}
const pro4pm = { id: 'f008d1d8b8b8', code: 'SPSW-004PE16EU', gen: 2, online: 1,
  status: { 'switch:0': { output: false, apower: 0 }, 'switch:1': { output: true, apower: 55 }, 'switch:2': { output: false }, 'switch:3': { output: true } } }
const plus1 = { id: 'aaaaaaaaaaaa', code: 'SNSW-001X16EU', gen: 2, online: 1, status: { 'switch:0': { output: true } } }
const em3 = { id: 'bbbbbbbbbbbb', code: 'SPEM-003CEBEU', gen: 2, online: 1, status: { 'em:0': { a_act_power: 1200 } } }
const gen1 = { id: 'cccccccccccc', type: 'SHPLG-S', gen: 1, online: true, status: { relays: [{ ison: true }], meters: [{ power: 30, total: 6000 }] } }
const gen3 = { id: 'dddddddddddd', code: 'S3PL-00112EU', gen: 3, online: 1, status: { 'switch:0': { output: false, apower: 0, aenergy: { total: 5 } } } }
const offline = { id: 'eeeeeeeeeeee', code: 'SNPL-00112EU', gen: 2, online: 0, status: {} }

describe('normaliseGetItems', () => {
  it('normalises a Plug S with every field, lowercasing the id', () => {
    const [d] = normaliseGetItems([plugS])
    expect(d).toMatchObject({ device_id: 'a8032abe41fc', online: true, gen: 2, model: 'SNPL-00112EU', name: 'Treadmill 1', supported: true })
    expect(d.channels).toEqual([{ channel: 0, output: true, apower: 412.3, aenergy_wh: 11679.5, temperature_c: 41.2, source: 'WS_in' }])
  })
  it('expands a Pro 4PM into four channels', () => {
    const [d] = normaliseGetItems([pro4pm])
    expect(d.channels.map((c) => c.channel)).toEqual([0, 1, 2, 3])
    expect(d.channels[1]).toMatchObject({ output: true, apower: 55 })
  })
  it('a non-metering Plus 1 has null power/energy, not zero', () => {
    const [d] = normaliseGetItems([plus1])
    expect(d.channels[0]).toMatchObject({ apower: null, aenergy_wh: null })
  })
  it('marks a Pro 3EM (no switch) and a Gen1 device unsupported, with reasons', () => {
    const [a, b] = normaliseGetItems([em3, gen1])
    expect(a).toMatchObject({ supported: false, reason: 'no_switch' })
    expect(b).toMatchObject({ supported: false, reason: 'gen1', online: true })
  })
  it('Gen3 is supported (gen >= 2)', () => {
    expect(normaliseGetItems([gen3])[0].supported).toBe(true)
  })
  it('an offline device with an empty status is supported:null with no channels, not unsupported', () => {
    const [d] = normaliseGetItems([offline])
    expect(d).toMatchObject({ online: false, supported: null, channels: [] })
  })
  it('tolerates wrapped bodies and drops entries without an id', () => {
    expect(normaliseGetItems({ data: [plugS, { gen: 2 }] })).toHaveLength(1)
    expect(normaliseGetItems(null)).toEqual([])
  })
})

describe('normaliseAllStatus (v1 discovery)', () => {
  it('flattens devices_status into per-channel rows and tolerates a missing _dev_info', () => {
    const body = { isok: true, data: { devices_status: {
      a8032abe41fc: { _dev_info: { code: 'SNPL-00112EU', gen: 'G2', online: true }, 'switch:0': { output: true }, sys: { device: { name: 'Fan' } } },
      f008d1d8b8b8: { 'switch:0': { output: false }, 'switch:1': { output: true } },
    } } }
    const rows = normaliseAllStatus(body)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({ device_id: 'a8032abe41fc', channel: 0, model: 'SNPL-00112EU', gen: 2, online: true, output: true, name: 'Fan', supported: true })
    expect(rows[2]).toMatchObject({ device_id: 'f008d1d8b8b8', channel: 1, output: true })
  })
  it('marks Gen1 shapes unsupported', () => {
    const body = { isok: true, data: { devices_status: { cccccccccccc: { _dev_info: { code: 'SHPLG-S', gen: 'G1' }, relays: [{ ison: true }] } } } }
    expect(normaliseAllStatus(body)[0]).toMatchObject({ supported: false, reason: 'gen1' })
  })
})

describe('stateFromReading / stateChanged', () => {
  const reading = normaliseGetItems([plugS])[0]
  it('builds last_state from a channel reading', () => {
    expect(stateFromReading(null, reading, 0, 'T1')).toEqual({ online: true, output: true, apower: 412.3, aenergy_wh: 11679.5, temperature_c: 41.2, source: 'WS_in', at: 'T1' })
  })
  it('offline keeps the previous output/apower and flips online', () => {
    const prev = { online: true, output: true, apower: 412.3, aenergy_wh: 11679.5, temperature_c: 41.2, source: 'WS_in', at: 'T1' }
    const off = normaliseGetItems([offline])[0]
    expect(stateFromReading(prev, off, 0, 'T2')).toEqual({ ...prev, online: false, at: 'T2' })
  })
  it('stateChanged ignores sub-threshold jitter but fires on output, online, 1 Wh, 1 °C, or a 5-minute refresh', () => {
    const base = { online: true, output: true, apower: 100, aenergy_wh: 10, temperature_c: 40, source: 'x', at: '2026-07-06T10:00:00.000Z' }
    expect(stateChanged(base, { ...base, apower: 100.3, at: '2026-07-06T10:01:00.000Z' })).toBe(false)
    expect(stateChanged(base, { ...base, output: false })).toBe(true)
    expect(stateChanged(base, { ...base, aenergy_wh: 11 })).toBe(true)
    expect(stateChanged(base, { ...base, temperature_c: 41 })).toBe(true)
    expect(stateChanged(base, { ...base, at: '2026-07-06T10:06:00.000Z' })).toBe(true)
    expect(stateChanged(null, base)).toBe(true)
  })
  it('groupId is <device_id>_<channel>', () => {
    expect(groupId({ device_id: 'a8032abe41fc', channel: 2 })).toBe('a8032abe41fc_2')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/shelly/status.test.js`
Expected: FAIL — `Failed to resolve import "./status"`.

- [ ] **Step 3: Write the module**

```js
// src/lib/shelly/status.js
// SHELLY.4 — pure normalisers for Shelly Cloud payloads. Defensive on
// purpose: the v2 `get` item field names and the v1 `all_status` `_dev_info`
// shape were read from docs, not a live account (see the spec's
// "unverified shapes"). Nothing here throws on a surprising body.

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null }
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)

function parseGen(raw) {
  if (raw == null) return null
  const m = String(raw).match(/(\d+)/)           // 2 | 'G2' | 'gen2'
  return m ? Number(m[1]) : null
}

function channelFromSwitch(n, sw) {
  const s = isObj(sw) ? sw : {}
  return {
    channel: n,
    output: typeof s.output === 'boolean' ? s.output : null,
    apower: num(s.apower),
    aenergy_wh: num(s.aenergy?.total),
    temperature_c: num(s.temperature?.tC),
    source: typeof s.source === 'string' ? s.source : null,
  }
}

function switchChannels(status) {
  const out = []
  for (const key of Object.keys(isObj(status) ? status : {})) {
    const m = key.match(/^switch:(\d+)$/)
    if (m) out.push(channelFromSwitch(Number(m[1]), status[key]))
  }
  return out.sort((a, b) => a.channel - b.channel)
}

function supportFor({ gen, online, status, channels }) {
  if ((gen != null && gen < 2) || Array.isArray(status?.relays) || Array.isArray(status?.meters)) {
    return { supported: false, reason: 'gen1' }
  }
  if (!online && !channels.length) return { supported: null }            // offline: status may be empty, don't judge
  if (!channels.length) return { supported: false, reason: 'no_switch' }  // 3EM etc.
  return { supported: true }
}

function nameFrom(settings, fallback) {
  return settings?.sys?.device?.name ?? settings?.name ?? fallback ?? null
}

export function normaliseGetItem(item) {
  if (!isObj(item) || item.id == null) return null
  const status = isObj(item.status) ? item.status : {}
  const online = item.online === 1 || item.online === true
  const gen = parseGen(item.gen)
  const channels = switchChannels(status)
  return {
    device_id: String(item.id).toLowerCase(),
    online, gen,
    model: item.code ?? item.type ?? null,
    name: nameFrom(item.settings, item.name),
    channels,
    ...supportFor({ gen, online, status, channels }),
  }
}

export function normaliseGetItems(body) {
  const list = Array.isArray(body) ? body
    : Array.isArray(body?.devices) ? body.devices
    : Array.isArray(body?.data) ? body.data : []
  return list.map(normaliseGetItem).filter(Boolean)
}

// v1 /device/all_status → one row per relay channel, for the adopt flow.
export function normaliseAllStatus(body) {
  const devices = isObj(body?.data?.devices_status) ? body.data.devices_status : {}
  const rows = []
  for (const [rawId, entry] of Object.entries(devices)) {
    const e = isObj(entry) ? entry : {}
    const info = isObj(e._dev_info) ? e._dev_info : {}
    const gen = parseGen(info.gen)
    const online = info.online === true || info.online === 1 || e.cloud?.connected === true
    const channels = switchChannels(e)
    const support = supportFor({ gen, online, status: e, channels })
    const base = {
      device_id: String(rawId).toLowerCase(), model: info.code ?? info.type ?? null, gen,
      online, name: nameFrom(e, null), ...support,
    }
    if (!channels.length) { rows.push({ ...base, channel: 0, output: null }); continue }
    for (const c of channels) rows.push({ ...base, channel: c.channel, output: c.output })
  }
  return rows
}

// next last_state for one adopted row. Offline: keep what we last knew
// about output/power, flip online, do NOT advance last_seen_at (caller).
export function stateFromReading(prev, reading, channel, atIso) {
  const p = isObj(prev) ? prev : {}
  if (!reading?.online) {
    return { online: false, output: p.output ?? null, apower: p.apower ?? null, aenergy_wh: p.aenergy_wh ?? null,
      temperature_c: p.temperature_c ?? null, source: p.source ?? null, at: atIso }
  }
  const c = (reading.channels || []).find((x) => x.channel === channel) || channelFromSwitch(channel, null)
  return { online: true, output: c.output, apower: c.apower, aenergy_wh: c.aenergy_wh, temperature_c: c.temperature_c, source: c.source, at: atIso }
}

const REFRESH_MS = 5 * 60 * 1000
export function stateChanged(prev, next) {
  if (!isObj(prev)) return true
  if (prev.online !== next.online || prev.output !== next.output || prev.source !== next.source) return true
  if (Math.abs((next.apower ?? 0) - (prev.apower ?? 0)) >= 0.5) return true
  if (Math.abs((next.aenergy_wh ?? 0) - (prev.aenergy_wh ?? 0)) >= 1) return true
  if (Math.abs((next.temperature_c ?? 0) - (prev.temperature_c ?? 0)) >= 1) return true
  const prevAt = Date.parse(prev.at || '')
  return !Number.isFinite(prevAt) || Date.parse(next.at) - prevAt >= REFRESH_MS
}

export const groupId = (d) => `${d.device_id}_${d.channel}`
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/shelly/status.test.js`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/shelly/status.js src/lib/shelly/status.test.js
git commit -m "SHELLY.4 — pure Shelly status normalisers (v2 get, v1 all_status, last_state shape)"
```

---
## Task 5: `src/lib/shelly/plan.js` — the exactly-once state machine

**Files:**
- Create: `src/lib/shelly/plan.js`
- Test: `src/lib/shelly/plan.test.js`

- [ ] **Step 1: Write the failing tests (the interplay table)**

```js
// src/lib/shelly/plan.test.js
import { describe, it, expect } from 'vitest'
import { planDeviceAction, overrideKey, windowKey } from './plan'

const DAY = '2026-07-06' // Monday, Dublin IST (+01:00)
const T = (hhmm, day = DAY) => Date.parse(`${day}T${hhmm}:00+01:00`)
const W = 'w:' + T('07:00')

const base = {
  enabled: true, schedule_mode: 'fixed',
  fixed_windows: [{ days: [1, 2, 3, 4, 5], on: '07:00', off: '21:30' }],
  class_rule: {}, override: null, last_applied: null,
}
const dev = (over = {}) => ({ ...base, ...over })
const ov = (state, until, set_at = '2026-07-06T19:00:00.000Z') => ({ state, until, set_at, set_by: 'u1' })
const plan = (d, hhmm, opts) => planDeviceAction(d, T(hhmm), DAY, [], 'Europe/Dublin', opts)

describe('planDeviceAction — windows', () => {
  it('1. first tick inside the window opens it', () => {
    expect(plan(dev(), '07:00')).toEqual({ action: 'on', reason: 'window_open', key: W })
  })
  it('2. a missed boundary tick self-heals', () => {
    expect(plan(dev(), '07:07')).toMatchObject({ action: 'on', key: W })
  })
  it('3. a human who switched off mid-window is left alone', () => {
    expect(plan(dev({ last_applied: { key: W, action: 'on' } }), '12:00')).toBe(null)
  })
  it('4. the window closes once', () => {
    expect(plan(dev({ last_applied: { key: W, action: 'on' } }), '21:30')).toEqual({ action: 'off', reason: 'window_close', key: W })
  })
  it('5. no double close', () => {
    expect(plan(dev({ last_applied: { key: W, action: 'off' } }), '21:35')).toBe(null)
  })
  it('6. never closes what we did not open (CRM down all day)', () => {
    expect(plan(dev(), '21:35')).toBe(null)
  })
  it('7. re-opens after its own close when the window is still active (differs from Sonos)', () => {
    expect(plan(dev({ last_applied: { key: W, action: 'off' } }), '12:00')).toMatchObject({ action: 'on', key: W })
  })
  it('14. serves the Sat 22:00–02:00 overnight tail at 00:30 Sunday', () => {
    const night = dev({ fixed_windows: [{ days: [6], on: '22:00', off: '02:00' }] })
    const sunday = '2026-07-12'
    const p = planDeviceAction(night, T('00:30', sunday), sunday, [], 'Europe/Dublin')
    expect(p).toMatchObject({ action: 'on', key: 'w:' + T('22:00', '2026-07-11') })
  })
  it('19. a numeric last_applied key never matches (string keys only)', () => {
    expect(plan(dev({ last_applied: { key: T('07:00'), action: 'on' } }), '12:00')).toMatchObject({ action: 'on' })
  })
  it('21. class mode with no occurrences closes — which is why the reconcile skips class devices on a LOAD ERROR', () => {
    const cls = dev({ schedule_mode: 'class', fixed_windows: [], last_applied: { key: 'w:1', action: 'on' } })
    expect(plan(cls, '12:00')).toMatchObject({ action: 'off', reason: 'window_close' })
  })
})

describe('planDeviceAction — overrides', () => {
  const until = '2026-07-06T23:00:00.000Z' // local midnight
  it('8. a live override wins and is keyed on set_at', () => {
    const d = dev({ override: ov('on', until), last_applied: { key: W, action: 'on' } })
    expect(plan(d, '20:00')).toEqual({ action: 'on', reason: 'override', key: overrideKey(d.override) })
  })
  it('9. a live override beats the window close', () => {
    const d = dev({ override: ov('on', until), last_applied: { key: overrideKey(ov('on', until)), action: 'on' } })
    expect(plan(d, '21:30')).toBe(null)
  })
  it('10. an expired ON override outside every window fires one off tagged override_expired', () => {
    const o = ov('on', until)
    const d = dev({ override: o, last_applied: { key: overrideKey(o), action: 'on' } })
    expect(planDeviceAction(d, Date.parse(until) + 60_000, '2026-07-07', [], 'Europe/Dublin'))
      .toEqual({ action: 'off', reason: 'override_expired', key: overrideKey(o) })
  })
  it('11. an expired OFF override does nothing', () => {
    const o = ov('off', until)
    const d = dev({ override: o, last_applied: { key: overrideKey(o), action: 'off' } })
    expect(planDeviceAction(d, Date.parse(until) + 60_000, '2026-07-07', [], 'Europe/Dublin')).toBe(null)
  })
  it('12. an override that never applied (device offline) still lets the window close at midnight', () => {
    const d = dev({ override: ov('on', until), last_applied: { key: W, action: 'on' } })
    expect(planDeviceAction(d, Date.parse(until) + 60_000, '2026-07-07', [], 'Europe/Dublin'))
      .toEqual({ action: 'off', reason: 'window_close', key: W })
  })
  it('13. back inside the window after an OFF override expires → on', () => {
    const o = ov('off', '2026-07-06T13:00:00.000Z', '2026-07-06T11:00:00.000Z')
    const d = dev({ override: o, last_applied: { key: overrideKey(o), action: 'off' } })
    expect(plan(d, '14:00')).toMatchObject({ action: 'on', reason: 'window_open', key: W })
  })
  it('15. mode none: applied once, then never touched, even after expiry', () => {
    const o = ov('on', until)
    const d = dev({ schedule_mode: 'none', fixed_windows: [], override: o })
    expect(plan(d, '20:00')).toMatchObject({ action: 'on', reason: 'override' })
    expect(plan({ ...d, last_applied: { key: overrideKey(o), action: 'on' } }, '20:01')).toBe(null)
    expect(planDeviceAction({ ...d, last_applied: { key: overrideKey(o), action: 'on' } }, Date.parse(until) + 60_000, '2026-07-07', [], 'Europe/Dublin')).toBe(null)
  })
  it('16. exactly once per set_at', () => {
    const o = ov('off', until)
    expect(plan(dev({ override: o, last_applied: { key: overrideKey(o), action: 'off' } }), '20:00')).toBe(null)
  })
  it('20. a DISABLED device still gets its override (a manual action is not the schedule)', () => {
    expect(plan(dev({ enabled: false, override: ov('off', until) }), '20:00')).toMatchObject({ action: 'off', reason: 'override' })
    expect(plan(dev({ enabled: false }), '12:00')).toBe(null)
  })
  it('falls back to until+state when set_at is missing', () => {
    expect(overrideKey({ state: 'on', until })).toBe(`ov:${until}:on`)
    expect(windowKey({ on_at: 5 })).toBe('w:5')
  })
})

describe('planDeviceAction — force (run-now)', () => {
  it('17. inside a window force re-applies even when already stamped, as run_now', () => {
    expect(plan(dev({ last_applied: { key: W, action: 'on' } }), '12:00', { force: true })).toEqual({ action: 'on', reason: 'run_now', key: W })
  })
  it('18. outside every window force means off with a run key, and the next plain tick is quiet', () => {
    const p = plan(dev(), '22:00', { force: true })
    expect(p).toMatchObject({ action: 'off', reason: 'run_now' })
    expect(p.key.startsWith('run:')).toBe(true)
    expect(plan(dev({ last_applied: { ...p } }), '22:01')).toBe(null)
  })
  it('force honours a live override', () => {
    const o = ov('off', '2026-07-06T23:00:00.000Z')
    expect(plan(dev({ override: o, last_applied: { key: overrideKey(o), action: 'off' } }), '20:00', { force: true }))
      .toEqual({ action: 'off', reason: 'run_now', key: overrideKey(o) })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/shelly/plan.test.js`
Expected: FAIL — `Failed to resolve import "./plan"`.

- [ ] **Step 3: Write the module**

```js
// src/lib/shelly/plan.js
// SHELLY.5 — boundary exactly-once planner for relays (the Sonos planAction
// model) plus a two-way manual override. Pure: no I/O, no clock.
//
// last_applied = { key, action, reason, at }. Keys are STRINGS by design —
// 'w:<on_at ms>' for a window, 'ov:<set_at>' for an override, 'run:<ms>' for
// run-now — so the Sonos toMs class of bug (a jsonb number that comes back as
// a string and never === matches) cannot happen here.
//
// Three things differ from Sonos, all because a relay's `on` is idempotent:
//  1. A live override is applied for EVERY adopted device, enabled or not —
//     a manual action is independent of the schedule, and applying it here
//     is what lets a failed direct toggle self-heal next tick.
//  2. Inside a window we re-open after our own close under the same key —
//     a class window that shrank for one tick (occurrence-sync blip) must not
//     leave the room dark all day.
//  3. Outside every window we close whenever the last thing WE did was an
//     `on`, window or override. A human's physical `on` is never stamped, so
//     it is never undone here. Humans win between boundaries.

import { resolveServeWindows } from '@/lib/schedule/desired-state'
import { DEFAULT_TZ } from '@/lib/tz-time'

export const overrideKey = (ov) => 'ov:' + (ov?.set_at || `${ov?.until}:${ov?.state}`)
export const windowKey = (w) => 'w:' + w.on_at

// → null | { action:'on'|'off', reason, key }
export function planDeviceAction(device, nowMs, dateStr, occurrences = [], tz = DEFAULT_TZ, { force = false } = {}) {
  const last = device?.last_applied && typeof device.last_applied === 'object' ? device.last_applied : null
  const same = (key, action) => last?.key === key && last?.action === action

  // 1. Live override — every adopted device.
  const ov = device?.override
  if (ov?.state && ov.until && new Date(ov.until).getTime() > nowMs) {
    const action = ov.state === 'on' ? 'on' : 'off'
    const key = overrideKey(ov)
    if (!force && same(key, action)) return null
    return { action, reason: force ? 'run_now' : 'override', key }
  }

  // 2. Unmanaged / schedule switched off: never touched.
  if (!device?.enabled || device.schedule_mode === 'none') return null

  const windows = resolveServeWindows(device, dateStr, occurrences, tz)
  const active = windows.find((w) => nowMs >= w.on_at && nowMs < w.off_at)

  // 3. Inside a window: on, unless THIS window is already on-stamped.
  if (active) {
    const key = windowKey(active)
    if (!force && same(key, 'on')) return null
    return { action: 'on', reason: force ? 'run_now' : 'window_open', key }
  }

  // 4. Outside every window: close only what we opened.
  if (force) return { action: 'off', reason: 'run_now', key: `run:${nowMs}` }
  if (last?.action === 'on' && typeof last.key === 'string') {
    return { action: 'off', reason: last.key.startsWith('ov:') ? 'override_expired' : 'window_close', key: last.key }
  }
  return null
}
```

- [ ] **Step 4: Run the tests under both zones**

Run: `TZ=Europe/Dublin npx vitest run src/lib/shelly/plan.test.js && TZ=America/New_York npx vitest run src/lib/shelly/plan.test.js`
Expected: PASS both (22 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/shelly/plan.js src/lib/shelly/plan.test.js
git commit -m "SHELLY.5 — exactly-once relay planner with two-way override"
```

---
## Task 6: `src/lib/shelly/energy.js` — the daily roll

**Files:**
- Create: `src/lib/shelly/energy.js`
- Test: `src/lib/shelly/energy.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// src/lib/shelly/energy.test.js
import { describe, it, expect } from 'vitest'
import { rollDailyEnergy } from './energy'

const at = (s) => `2026-07-06T${s}.000Z`

describe('rollDailyEnergy', () => {
  it('first sample ever opens today with zero consumption', () => {
    expect(rollDailyEnergy(null, { total_wh: 1000, at: at('06:00:00') }, '2026-07-06')).toEqual({
      day: '2026-07-06', wh_start: 1000, wh_last: 1000, wh_total: 0, samples: 1, resets: 0,
      first_sample_at: at('06:00:00'), last_sample_at: at('06:00:00'),
    })
  })
  it('same day accumulates the positive delta', () => {
    const prev = { day: '2026-07-06', wh_start: 1000, wh_last: 1000, wh_total: 0, samples: 1, resets: 0, first_sample_at: at('06:00:00'), last_sample_at: at('06:00:00') }
    expect(rollDailyEnergy(prev, { total_wh: 1007.5, at: at('06:01:00') }, '2026-07-06')).toMatchObject({ wh_last: 1007.5, wh_total: 7.5, samples: 2, last_sample_at: at('06:01:00') })
  })
  it('a new day starts from yesterday\'s wh_last so the straddling minute lands in today', () => {
    const prev = { day: '2026-07-05', wh_start: 900, wh_last: 1000, wh_total: 100, samples: 1440, resets: 0, first_sample_at: 'x', last_sample_at: 'y' }
    expect(rollDailyEnergy(prev, { total_wh: 1003, at: at('00:00:30') }, '2026-07-06')).toMatchObject({ day: '2026-07-06', wh_start: 1000, wh_last: 1003, wh_total: 3, samples: 1, resets: 0 })
  })
  it('a drop to under half the previous value is a reset: count from zero and record it', () => {
    const prev = { day: '2026-07-06', wh_start: 50000, wh_last: 50000, wh_total: 40, samples: 10, resets: 0, first_sample_at: 'x', last_sample_at: 'y' }
    expect(rollDailyEnergy(prev, { total_wh: 12, at: at('10:00:00') }, '2026-07-06')).toMatchObject({ wh_last: 12, wh_total: 52, resets: 1 })
  })
  it('a small rollback (flash-save lag after a power cut) counts nothing and is not a reset', () => {
    const prev = { day: '2026-07-06', wh_start: 50000, wh_last: 50000, wh_total: 40, samples: 10, resets: 0, first_sample_at: 'x', last_sample_at: 'y' }
    expect(rollDailyEnergy(prev, { total_wh: 49990, at: at('10:00:00') }, '2026-07-06')).toMatchObject({ wh_last: 49990, wh_total: 40, resets: 0 })
  })
  it('non-finite or negative totals produce no row', () => {
    expect(rollDailyEnergy(null, { total_wh: null, at: 'x' }, '2026-07-06')).toBe(null)
    expect(rollDailyEnergy(null, { total_wh: -1, at: 'x' }, '2026-07-06')).toBe(null)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/shelly/energy.test.js`
Expected: FAIL — `Failed to resolve import "./energy"`.

- [ ] **Step 3: Write the module**

```js
// src/lib/shelly/energy.js
// SHELLY.6 — roll a monotonic Wh counter (aenergy.total) into per-local-day
// rows. wh_total is the SUM OF POSITIVE DELTAS, never wh_last - wh_start:
// the counter resets on a factory reset and some firmware updates, and can
// roll back a few Wh after a power cut (flash-save lag). A drop to under
// half the previous value is a reset (count the new total from zero); a
// smaller drop is a rollback (count nothing). A new day starts from
// yesterday's wh_last so the minute that straddles midnight — or a whole
// cron outage — lands in today rather than nowhere.
//
// prevRow = the LATEST shelly_energy_daily row for this device (today or an
// earlier day) or null. Returns the full next row (every NOT NULL column
// present) or null when the sample is unusable.

export function rollDailyEnergy(prevRow, sample, localDay) {
  const total = Number(sample?.total_wh)
  if (!Number.isFinite(total) || total < 0) return null
  const prevLast = prevRow ? Number(prevRow.wh_last) : null
  let delta = 0
  let reset = 0
  if (prevLast != null && Number.isFinite(prevLast)) {
    if (total >= prevLast) delta = total - prevLast
    else if (total < prevLast / 2) { delta = total; reset = 1 }
    else delta = 0
  }
  if (!prevRow || prevRow.day !== localDay) {
    return {
      day: localDay, wh_start: prevLast ?? total, wh_last: total, wh_total: delta,
      samples: 1, resets: reset, first_sample_at: sample.at, last_sample_at: sample.at,
    }
  }
  return {
    ...prevRow, wh_last: total, wh_total: Number(prevRow.wh_total) + delta,
    samples: Number(prevRow.samples) + 1, resets: Number(prevRow.resets) + reset, last_sample_at: sample.at,
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/shelly/energy.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/shelly/energy.js src/lib/shelly/energy.test.js
git commit -m "SHELLY.6 — daily energy roll with reset and rollback handling"
```

---

## Task 7: `src/lib/shelly/connections.js` — connection loaders and the cross-org rule

**Files:**
- Create: `src/lib/shelly/connections.js`
- Test: `src/lib/shelly/connections.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// src/lib/shelly/connections.test.js
import { describe, it, expect, vi } from 'vitest'
import { classifyFingerprintClash, publicConnectionView, probeConnection, findFingerprintRows, loadConnection } from './connections'

const row = (location_id, organization_id, name) => ({ location_id, locations: { organization_id, name } })

describe('classifyFingerprintClash', () => {
  it('no rows → ok', () => expect(classifyFingerprintClash([], 'org-A', 'loc-1')).toEqual({ ok: true, shared_with: [] }))
  it('own location (re-paste) → ok', () => expect(classifyFingerprintClash([row('loc-1', 'org-A', 'Mine')], 'org-A', 'loc-1')).toEqual({ ok: true, shared_with: [] }))
  it('same org, other location → ok and named', () => {
    expect(classifyFingerprintClash([row('loc-2', 'org-A', 'Hatch Street')], 'org-A', 'loc-1')).toEqual({ ok: true, shared_with: ['Hatch Street'] })
  })
  it('another organisation → refused, without naming it', () => {
    const r = classifyFingerprintClash([row('loc-9', 'org-B', 'Rival Gym')], 'org-A', 'loc-1')
    expect(r).toEqual({ ok: false, reason: 'other_org' })
    expect(JSON.stringify(r)).not.toContain('Rival')
  })
})

describe('publicConnectionView', () => {
  it('never includes the key or fingerprint', () => {
    const v = publicConnectionView({ id: 'c1', host: 'shelly-1-eu.shelly.cloud', auth_key: 'SECRET', auth_key_fingerprint: 'f'.repeat(64), key_hint: 'CRET', status: 'connected', last_ok_at: 'T', last_error: null, last_error_at: null })
    expect(v).toEqual({ host: 'shelly-1-eu.shelly.cloud', key_hint: 'CRET', has_auth_key: true, status: 'connected', last_ok_at: 'T', last_error: null, last_error_at: null })
    expect(JSON.stringify(v)).not.toContain('SECRET')
    expect(JSON.stringify(v)).not.toContain('f'.repeat(64))
  })
})

describe('probeConnection', () => {
  it('maps auth, network and ok (with a device count)', async () => {
    const mk = (res) => ({ makeClient: () => ({ allStatus: async () => res }) })
    expect(await probeConnection({}, mk({ ok: false, kind: 'auth', statusCode: 401 }))).toEqual({ ok: false, kind: 'auth', statusCode: 401 })
    expect(await probeConnection({}, mk({ ok: false, kind: 'network', statusCode: 0 }))).toEqual({ ok: false, kind: 'network', statusCode: 0 })
    expect(await probeConnection({}, mk({ ok: true, statusCode: 200, body: { isok: true, data: { devices_status: { a: {}, b: {} } } } }))).toEqual({ ok: true, deviceCount: 2 })
  })
})

describe('db loaders', () => {
  it('findFingerprintRows selects only location + org/name and filters on the fingerprint', async () => {
    const calls = []
    const db = { from: (t) => ({ select: (cols) => ({ eq: (c, v) => ({ limit: async (n) => { calls.push({ t, cols, c, v, n }); return { data: [], error: null } } }) }) }) }
    expect(await findFingerprintRows(db, 'abc')).toEqual({ ok: true, rows: [] })
    expect(calls[0]).toMatchObject({ t: 'shelly_connections', c: 'auth_key_fingerprint', v: 'abc', n: 50 })
    expect(calls[0].cols).not.toContain('auth_key,')
  })
  it('loadConnection returns not_connected on no row and db_error on error', async () => {
    const mk = (data, error) => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data, error }) }) }) }) })
    expect(await loadConnection(mk(null, null), 'loc')).toEqual({ ok: false, reason: 'not_connected' })
    expect(await loadConnection(mk(null, { message: 'boom' }), 'loc')).toEqual({ ok: false, reason: 'db_error', error: 'boom' })
    expect(await loadConnection(mk({ id: 'c1' }, null), 'loc')).toEqual({ ok: true, connection: { id: 'c1' } })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/shelly/connections.test.js`
Expected: FAIL — `Failed to resolve import "./connections"`.

- [ ] **Step 3: Write the module**

```js
// src/lib/shelly/connections.js
// SHELLY.7 — shelly_connections access. loadConnection returns the FULL row
// including auth_key and is SERVER ONLY: a route must never return that
// object. publicConnectionView is the only shape a route may return.
//
// The cross-org rule (spec "Tenancy"): the key's sha256 fingerprint is
// deliberately NOT unique — an owner with two studios may run both off one
// Shelly account — but a key already linked at a location in ANOTHER
// organisation is refused, and the refusal never names that organisation.
// Mirrors chooseTenantToBind (src/lib/xero/tenant-binding.js).

import { createShellyClient } from './client'

const NON_SECRET = 'id, location_id, host, key_hint, status, last_ok_at, last_error, last_error_at, linked_by, created_at, updated_at'

export function classifyFingerprintClash(rows, organizationId, locationId) {
  const shared_with = []
  for (const r of rows || []) {
    if (r.location_id === locationId) continue                       // re-paste on our own location
    if (r.locations?.organization_id !== organizationId) return { ok: false, reason: 'other_org' }
    shared_with.push(r.locations?.name || 'another location')
  }
  return { ok: true, shared_with }
}

export async function findFingerprintRows(db, fingerprint) {
  const { data, error } = await db
    .from('shelly_connections')
    .select('location_id, locations(organization_id, name)')
    .eq('auth_key_fingerprint', fingerprint)
    .limit(50)
  if (error) return { ok: false, error: error.message }
  return { ok: true, rows: data || [] }
}

// Full row, key included. Server-side callers only (cron, toggle, discover).
export async function loadConnection(db, locationId) {
  const { data, error } = await db
    .from('shelly_connections')
    .select('*')
    .eq('location_id', locationId)
    .maybeSingle()   // 0 rows is the normal "not connected" answer
  if (error) return { ok: false, reason: 'db_error', error: error.message }
  if (!data) return { ok: false, reason: 'not_connected' }
  return { ok: true, connection: data }
}

export async function loadPublicConnection(db, locationId) {
  const { data, error } = await db.from('shelly_connections').select(NON_SECRET).eq('location_id', locationId).maybeSingle()
  if (error) return { ok: false, reason: 'db_error', error: error.message }
  if (!data) return { ok: false, reason: 'not_connected' }
  return { ok: true, connection: publicConnectionView(data) }
}

export function publicConnectionView(conn) {
  return {
    host: conn.host,
    key_hint: conn.key_hint,
    has_auth_key: true,
    status: conn.status,
    last_ok_at: conn.last_ok_at ?? null,
    last_error: conn.last_error ?? null,
    last_error_at: conn.last_error_at ?? null,
  }
}

// One v1 all_status call: validates a pasted key before it is saved.
export async function probeConnection(conn, { makeClient = createShellyClient } = {}) {
  const res = await makeClient(conn).allStatus()
  if (!res.ok) return { ok: false, kind: res.kind, statusCode: res.statusCode }
  const devices = res.body?.data?.devices_status
  return { ok: true, deviceCount: devices && typeof devices === 'object' ? Object.keys(devices).length : 0 }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/shelly/connections.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/shelly/connections.js src/lib/shelly/connections.test.js
git commit -m "SHELLY.7 — connection loaders, public view, cross-org key refusal"
```

---
## Task 8: `src/lib/shelly/reconcile.js` — orchestration

All I/O is injected (`makeClient`, `sleep`, `now`, `loadOccurrences`), so the tests use a fake db that records writes and throws on any unexpected table. Every write destructures `error`.

**Files:**
- Create: `src/lib/shelly/reconcile.js`
- Test: `src/lib/shelly/reconcile.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// src/lib/shelly/reconcile.test.js
import { describe, it, expect, vi } from 'vitest'
import { runShellyReconcile, reconcileLocation, runNowForDevice, loadTodayOccurrences, MAX_DEVICES } from './reconcile'
import { logWarn, logError } from '@/lib/log'

vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))

const NOW = Date.parse('2026-07-06T06:00:00+01:00')   // Monday 07:00 Dublin → inside the 07:00–21:30 window
const KEY = 'SECRET-KEY-1'
const conn = (over = {}) => ({ id: 'c1', location_id: 'loc-1', host: 'shelly-1-eu.shelly.cloud', auth_key: KEY, auth_key_fingerprint: 'fp1', status: 'connected', last_error_at: null, locations: { timezone: 'Europe/Dublin' }, ...over })
const device = (over = {}) => ({ id: 'd1', location_id: 'loc-1', device_id: 'a8032abe41fc', channel: 0, enabled: true, schedule_mode: 'fixed',
  fixed_windows: [{ days: [1, 2, 3, 4, 5], on: '07:00', off: '21:30' }], class_rule: {}, override: null, last_applied: null, last_state: null, last_seen_at: null, ...over })
const item = (id, over = {}) => ({ id, code: 'SNPL-00112EU', gen: 2, online: 1, status: { 'switch:0': { output: false, apower: 0, aenergy: { total: 100 } } }, ...over })

// Fake db: records every write; throws on a table the code should never touch.
function makeDb({ connections = [], devices = [], energy = [], occurrences = [] } = {}) {
  const writes = []
  const chain = (rows) => {
    const q = {
      eq: () => q, gte: () => q, lte: () => q, lt: () => q, is: () => q, order: () => q, in: () => q,
      limit: async () => ({ data: rows, error: null }),
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      then: (res) => res({ data: rows, error: null }),
    }
    return q
  }
  return {
    writes,
    from(table) {
      const rows = { shelly_connections: connections, shelly_devices: devices, shelly_energy_daily: energy, class_occurrences: occurrences }[table]
      if (!rows) throw new Error(`unexpected table ${table}`)
      return {
        select: () => chain(rows),
        update: (patch) => ({ eq: async (col, val) => { writes.push({ table, op: 'update', [col]: val, patch }); return { error: null } } }),
        upsert: async (rowsIn, opts) => { writes.push({ table, op: 'upsert', rows: rowsIn, opts }); return { error: null } },
      }
    },
  }
}

function fakeClient(script = {}) {
  const calls = []
  return {
    calls,
    factory: () => ({
      get: vi.fn(async (ids) => { calls.push({ m: 'get', ids }); return script.get ? script.get(ids) : { ok: true, statusCode: 200, body: ids.map((id) => item(id)) } }),
      setGroups: vi.fn(async (ids, on) => { calls.push({ m: 'setGroups', ids, on }); return script.setGroups ? script.setGroups(ids, on) : { ok: true, statusCode: 200, failed: {} } }),
      setSwitch: vi.fn(async (id, ch, on) => { calls.push({ m: 'setSwitch', id, ch, on }); return script.setSwitch ? script.setSwitch(id, ch, on) : { ok: true, statusCode: 200 } }),
      allStatus: vi.fn(),
    }),
  }
}
const ctx = (client, over = {}) => ({ now: () => NOW, sleep: vi.fn(async () => {}), makeClient: client.factory, loadOccurrences: async () => ({ ok: true, occurrences: [] }), deadlineAt: NOW + 90_000, ...over })

describe('runShellyReconcile', () => {
  it('is dormant with zero connections: no client, no writes', async () => {
    const client = fakeClient()
    const out = await runShellyReconcile(makeDb(), { makeClient: client.factory, now: () => NOW })
    expect(out).toEqual({ ok: true, locations: 0 })
    expect(client.calls).toHaveLength(0)
  })
  it('parks a connection that went action_needed less than 15 minutes ago, reconciles the rest', async () => {
    const client = fakeClient()
    const db = makeDb({ connections: [conn(), conn({ id: 'c2', location_id: 'loc-2', auth_key_fingerprint: 'fp2', status: 'action_needed', last_error_at: new Date(NOW - 60_000).toISOString() })], devices: [device()] })
    const out = await runShellyReconcile(db, { makeClient: client.factory, now: () => NOW, sleep: async () => {} })
    expect(out).toMatchObject({ ok: true, locations: 1, parked: 1 })
  })
  it('a thrown error in one location is caught, logged with the key redacted, and the sweep continues', async () => {
    const client = fakeClient({ get: () => { throw new Error(`boom ${KEY}`) } })
    const db = makeDb({ connections: [conn(), conn({ id: 'c2', location_id: 'loc-2', auth_key_fingerprint: 'fp2' })], devices: [device()] })
    const out = await runShellyReconcile(db, { makeClient: client.factory, now: () => NOW, sleep: async () => {} })
    expect(out.crashed).toBe(2)
    expect(JSON.stringify(logError.mock.calls)).not.toContain(KEY)
    expect(JSON.stringify(logError.mock.calls)).toContain('[redacted]')
  })
})

describe('reconcileLocation', () => {
  it('reads in batches of 10 unique device ids and opens the active window with one set/groups call', async () => {
    const client = fakeClient()
    const devices = Array.from({ length: 12 }, (_, i) => device({ id: `d${i}`, device_id: `id${i}`, channel: 0 }))
    devices.push(device({ id: 'd12', device_id: 'id0', channel: 1 }))          // second channel, same id → deduped read
    const db = makeDb({ devices })
    const out = await reconcileLocation(db, conn(), ctx(client))
    const gets = client.calls.filter((c) => c.m === 'get')
    expect(gets.map((g) => g.ids.length)).toEqual([10, 2])
    const groups = client.calls.filter((c) => c.m === 'setGroups')
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ on: true })
    expect(groups[0].ids).toContain('id0_1')
    expect(out).toMatchObject({ devices: 13, applied: 13, failed: 0 })
    const stamps = db.writes.filter((w) => w.patch?.last_applied)
    expect(stamps[0].patch.last_applied).toMatchObject({ key: expect.stringMatching(/^w:\d+$/), action: 'on', reason: 'window_open' })
  })
  it('a failedCommands entry is not stamped, counted as failed', async () => {
    const client = fakeClient({ setGroups: (ids) => ({ ok: true, failed: { [ids[0]]: 'DEVICE_OFFLINE' } }) })
    const db = makeDb({ devices: [device()] })
    const out = await reconcileLocation(db, conn(), ctx(client))
    expect(out).toMatchObject({ applied: 0, failed: 1 })
    expect(db.writes.filter((w) => w.patch?.last_applied)).toHaveLength(0)
  })
  it('writes last_state only when changed; offline keeps previous output and does not touch last_seen_at', async () => {
    const prev = { online: true, output: true, apower: 50, aenergy_wh: 100, temperature_c: 30, source: 'x', at: new Date(NOW - 60_000).toISOString() }
    const client = fakeClient({ get: (ids) => ({ ok: true, statusCode: 200, body: ids.map((id) => item(id, { online: 0, status: {} })) }) })
    const db = makeDb({ devices: [device({ last_state: prev, last_seen_at: 'SEEN' })] })
    await reconcileLocation(db, conn(), ctx(client))
    const st = db.writes.find((w) => w.patch?.last_state)
    expect(st.patch.last_state).toMatchObject({ online: false, output: true, apower: 50 })
    expect(st.patch.last_seen_at).toBeUndefined()
  })
  it('rolls energy into one bulk upsert keyed by the location\'s local day', async () => {
    const client = fakeClient()
    const db = makeDb({ devices: [device()] })
    await reconcileLocation(db, conn(), ctx(client))
    const up = db.writes.find((w) => w.op === 'upsert')
    expect(up.opts).toEqual({ onConflict: 'device_id,day' })
    expect(up.rows[0]).toMatchObject({ device_id: 'd1', location_id: 'loc-1', day: '2026-07-06', wh_last: 100, samples: 1 })
  })
  it('a NY location keys its day locally (03:30Z = previous local day)', async () => {
    const client = fakeClient()
    const db = makeDb({ devices: [device()] })
    const ny = conn({ locations: { timezone: 'America/New_York' } })
    await reconcileLocation(db, ny, ctx(client, { now: () => Date.parse('2026-07-07T03:30:00Z'), deadlineAt: Infinity }))
    expect(db.writes.find((w) => w.op === 'upsert').rows[0].day).toBe('2026-07-06')
  })
  it('an auth failure marks the connection action_needed and writes nothing else', async () => {
    const client = fakeClient({ get: () => ({ ok: false, kind: 'auth', statusCode: 401 }) })
    const db = makeDb({ devices: [device()] })
    const out = await reconcileLocation(db, conn(), ctx(client))
    expect(out.authFailures).toBe(1)
    expect(db.writes).toHaveLength(1)
    expect(db.writes[0]).toMatchObject({ table: 'shelly_connections', patch: { status: 'action_needed' } })
    expect(db.writes[0].patch.last_error).not.toContain(KEY)
  })
  it('a class-occurrence LOAD ERROR skips class devices but still plans fixed ones', async () => {
    const client = fakeClient()
    const db = makeDb({ devices: [device(), device({ id: 'd2', device_id: 'bbbbbbbbbbbb', schedule_mode: 'class', fixed_windows: [], last_applied: { key: 'w:1', action: 'on' } })] })
    const out = await reconcileLocation(db, conn(), ctx(client, { loadOccurrences: async () => ({ ok: false, error: 'timeout' }) }))
    expect(out).toMatchObject({ skippedClass: 1, applied: 1 })
    expect(client.calls.filter((c) => c.m === 'setGroups' && c.on === false)).toHaveLength(0)
  })
  it('a live override on a DISABLED device is applied once', async () => {
    const client = fakeClient()
    const ov = { state: 'off', until: new Date(NOW + 3_600_000).toISOString(), set_at: 'S', set_by: 'u' }
    const db = makeDb({ devices: [device({ enabled: false, override: ov })] })
    await reconcileLocation(db, conn(), ctx(client))
    expect(client.calls.find((c) => c.m === 'setGroups')).toMatchObject({ on: false })
    expect(db.writes.find((w) => w.patch?.last_applied).patch.last_applied).toMatchObject({ key: 'ov:S', reason: 'override' })
  })
  it('stops issuing calls past the deadline and logs once', async () => {
    const client = fakeClient()
    const db = makeDb({ devices: [device()] })
    const out = await reconcileLocation(db, conn(), ctx(client, { deadlineAt: NOW - 1 }))
    expect(client.calls).toHaveLength(0)
    expect(out.devices).toBe(1)
  })
  it('warns when the device cap is exceeded and reconciles only MAX_DEVICES', async () => {
    const client = fakeClient()
    const devices = Array.from({ length: MAX_DEVICES + 1 }, (_, i) => device({ id: `d${i}`, device_id: `id${i}` }))
    const out = await reconcileLocation(makeDb({ devices }), conn(), ctx(client))
    expect(out.devices).toBe(MAX_DEVICES)
    expect(JSON.stringify(logWarn.mock.calls)).toContain('device cap')
  })
})

describe('runNowForDevice', () => {
  it('applies the forced plan through setSwitch and stamps on success', async () => {
    const client = fakeClient()
    const db = makeDb({ devices: [device()] })
    const out = await runNowForDevice(db, conn(), device(), { now: () => NOW, makeClient: client.factory, loadOccurrences: async () => ({ ok: true, occurrences: [] }) })
    expect(out).toMatchObject({ ok: true, action: 'on', reason: 'run_now' })
    expect(client.calls[0]).toMatchObject({ m: 'setSwitch', id: 'a8032abe41fc', ch: 0, on: true })
    expect(db.writes[0].patch.last_applied).toMatchObject({ action: 'on', reason: 'run_now' })
  })
  it('does not stamp on a failed command', async () => {
    const client = fakeClient({ setSwitch: () => ({ ok: false, kind: 'device', code: 'DEVICE_OFFLINE' }) })
    const db = makeDb({ devices: [device()] })
    const out = await runNowForDevice(db, conn(), device(), { now: () => NOW, makeClient: client.factory })
    expect(out).toMatchObject({ ok: false, kind: 'device', code: 'DEVICE_OFFLINE' })
    expect(db.writes).toHaveLength(0)
  })
  it('mode none without an override is a no-op', async () => {
    const out = await runNowForDevice(makeDb(), conn(), device({ schedule_mode: 'none' }), { now: () => NOW, makeClient: fakeClient().factory })
    expect(out).toEqual({ ok: true, noop: true })
  })
})

describe('loadTodayOccurrences', () => {
  it('bounds the query to the location\'s local day exactly', async () => {
    const filters = []
    const db = { from: () => ({ select: () => ({ eq: () => ({ gte: (c, v) => { filters.push(['gte', v]); return { lt: (c2, v2) => { filters.push(['lt', v2]); return { is: () => ({ limit: async () => ({ data: [], error: null }) }) } } } } }) }) }) }
    await loadTodayOccurrences(db, 'loc-1', 'America/New_York', Date.parse('2026-07-07T03:30:00Z'))
    expect(filters).toEqual([['gte', '2026-07-06T04:00:00.000Z'], ['lt', '2026-07-07T04:00:00.000Z']])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/shelly/reconcile.test.js`
Expected: FAIL — `Failed to resolve import "./reconcile"`.

- [ ] **Step 3: Write the module**

```js
// src/lib/shelly/reconcile.js
// SHELLY.8 — per-minute orchestration. All I/O injected. Never throws out of
// runShellyReconcile; per-location failures are counted and logged with the
// key redacted. Order per location: read state → write last_state → roll
// energy → plan → write (≤1 set/groups per direction) → connection status.

import { logWarn, logError } from '@/lib/log'
import { addDaysISO } from '@/lib/dublin-time'
import { dayStrInTz, dayStartMsInTz, resolveTz } from '@/lib/tz-time'
import { createShellyClient, redactSecret } from './client'
import { normaliseGetItems, stateFromReading, stateChanged, groupId } from './status'
import { planDeviceAction } from './plan'
import { rollDailyEnergy } from './energy'

const MODULE = 'shelly-reconcile'
export const MAX_CONNECTIONS = 100
export const MAX_DEVICES = 50
export const READ_BATCH = 10
export const ACTION_NEEDED_RETRY_MS = 15 * 60_000
const AUTH_ERROR = 'Shelly rejected the auth key — re-paste it from the Shelly app'
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Today's NON-cancelled occurrences for the location's LOCAL day, exactly.
// [dayStart, nextDayStart) — DST-exact, never +24h/+36h: the engine collapses
// every occurrence it is given into one window, so tomorrow's 06:00 class
// would hold devices on all night (the Tapo trap).
export async function loadTodayOccurrences(db, locationId, tz, nowMs) {
  const day = dayStrInTz(nowMs, tz)
  const start = new Date(dayStartMsInTz(day, tz)).toISOString()
  const end = new Date(dayStartMsInTz(addDaysISO(day, 1), tz)).toISOString()
  const { data, error } = await db.from('class_occurrences')
    .select('starts_at, ends_at, cancelled_at')
    .eq('location_id', locationId).gte('starts_at', start).lt('starts_at', end)
    .is('cancelled_at', null).limit(500)
  if (error) return { ok: false, error: error.message }
  return { ok: true, occurrences: data || [] }
}

async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length)
  let i = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]) }
  })
  await Promise.all(workers)
  return out
}

function sumCounters(list) {
  const acc = {}
  for (const o of list) for (const [k, v] of Object.entries(o || {})) if (typeof v === 'number') acc[k] = (acc[k] || 0) + v
  return acc
}

async function markConnection(db, conn, patch) {
  const { error } = await db.from('shelly_connections').update(patch).eq('id', conn.id)
  if (error) logWarn(MODULE, 'connection status write failed', { locationId: conn.location_id, error: error.message })
}

export async function runShellyReconcile(db, deps = {}) {
  const { now = Date.now, sleep = realSleep, makeClient = createShellyClient, loadOccurrences = loadTodayOccurrences, budgetMs = 90_000, concurrency = 4 } = deps
  const startedAt = now()
  const deadlineAt = startedAt + budgetMs
  const { data: conns, error } = await db.from('shelly_connections')
    .select('id, location_id, host, auth_key, auth_key_fingerprint, status, last_error_at, locations(timezone)')
    .order('created_at', { ascending: true })
    .limit(MAX_CONNECTIONS + 1)
  if (error) { logWarn(MODULE, 'connection load failed', { error: error.message }); return { ok: false } }
  if (!conns?.length) return { ok: true, locations: 0 }               // dormant: the rows ARE the config
  if (conns.length > MAX_CONNECTIONS) logWarn(MODULE, 'connection cap exceeded, excess skipped this tick', { cap: MAX_CONNECTIONS })

  const active = []
  let parked = 0
  for (const c of conns.slice(0, MAX_CONNECTIONS)) {
    const recent = c.status === 'action_needed' && c.last_error_at && now() - Date.parse(c.last_error_at) < ACTION_NEEDED_RETRY_MS
    if (recent) parked++; else active.push(c)
  }
  // Same fingerprint = same Shelly account = one 1 req/s budget → serial.
  // Different accounts are independent → parallel, bounded.
  const groups = [...Map.groupBy(active, (c) => c.auth_key_fingerprint).values()]
  const ctx = { now, sleep, makeClient, loadOccurrences, deadlineAt }
  const perLocation = await mapWithConcurrency(groups, concurrency, async (group) => {
    const outs = []
    for (const c of group) {
      try { outs.push(await reconcileLocation(db, c, ctx)) }
      catch (e) {
        logError(MODULE, 'location reconcile crashed', { locationId: c.location_id, err: redactSecret(e, c.auth_key) })
        outs.push({ crashed: 1 })
      }
    }
    return outs
  })
  return { ok: true, locations: active.length, parked, ...sumCounters(perLocation.flat()), elapsedMs: now() - startedAt }
}

// Steps (2)+(3): read state for the given device rows, write changed last_state.
// Shared with POST /api/shelly/refresh (PR 2). Returns readings + counters.
export async function refreshLocationState(db, conn, devices, ctx) {
  const { now, deadlineAt = Infinity } = ctx
  const client = ctx.client || ctx.makeClient(conn, { sleep: ctx.sleep, now })
  const nowIso = new Date(now()).toISOString()
  const out = { reads: 0, readFailures: 0, rateLimited: 0, stateWrites: 0, auth: false, anyOk: false, lastKind: null }
  const ids = [...new Set(devices.map((d) => d.device_id))]
  const readings = new Map()
  for (let i = 0; i < ids.length; i += READ_BATCH) {
    if (now() > deadlineAt) { logWarn(MODULE, 'deadline reached during reads', { locationId: conn.location_id }); break }
    const res = await client.get(ids.slice(i, i + READ_BATCH))
    out.reads++
    if (res.ok) { out.anyOk = true; for (const r of normaliseGetItems(res.body)) readings.set(r.device_id, r) }
    else { out.readFailures++; out.lastKind = res.kind; if (res.kind === 'rate_limited') out.rateLimited++; if (res.kind === 'auth') { out.auth = true; break } }
  }
  if (!out.auth) {
    await Promise.all(devices.map(async (d) => {
      const r = readings.get(d.device_id)
      if (!r) return
      const next = stateFromReading(d.last_state, r, d.channel, nowIso)
      if (!stateChanged(d.last_state, next)) return
      const patch = { last_state: next, updated_at: nowIso, ...(next.online ? { last_seen_at: nowIso } : {}) }
      const { error } = await db.from('shelly_devices').update(patch).eq('id', d.id)
      if (error) logWarn(MODULE, 'state write failed', { deviceId: d.id, error: error.message }); else out.stateWrites++
    }))
  }
  return { readings, client, nowIso, ...out }
}

export async function reconcileLocation(db, conn, ctx) {
  const { now, loadOccurrences, deadlineAt } = ctx
  const tz = resolveTz(conn.locations?.timezone)
  if (tz !== conn.locations?.timezone) logWarn(MODULE, 'invalid location timezone, using default', { locationId: conn.location_id })
  const nowMs = now()
  const dateStr = dayStrInTz(nowMs, tz)
  const out = { devices: 0, planned: 0, applied: 0, failed: 0, authFailures: 0, skippedClass: 0, energyWrites: 0 }

  const { data: rows, error: devErr } = await db.from('shelly_devices').select('*')
    .eq('location_id', conn.location_id).order('created_at', { ascending: true }).limit(MAX_DEVICES + 1)
  if (devErr) { logWarn(MODULE, 'device load failed', { locationId: conn.location_id, error: devErr.message }); return out }
  if ((rows || []).length > MAX_DEVICES) logWarn(MODULE, 'device cap exceeded, excess ignored this tick', { locationId: conn.location_id, cap: MAX_DEVICES })
  const devices = (rows || []).slice(0, MAX_DEVICES)
  out.devices = devices.length
  if (!devices.length) return out
  if (now() > deadlineAt) { logWarn(MODULE, 'deadline reached before reads', { locationId: conn.location_id }); return out }

  const st = await refreshLocationState(db, conn, devices, ctx)
  const { readings, client, nowIso } = st
  Object.assign(out, { reads: st.reads, readFailures: st.readFailures, rateLimited: st.rateLimited, stateWrites: st.stateWrites })
  let anyOk = st.anyOk, auth = st.auth, lastKind = st.lastKind
  if (auth) {
    out.authFailures++
    await markConnection(db, conn, { status: 'action_needed', last_error: AUTH_ERROR, last_error_at: nowIso, updated_at: nowIso })
    return out
  }

  // Energy — one bulk upsert per location.
  const { data: eRows, error: eErr } = await db.from('shelly_energy_daily').select('*')
    .eq('location_id', conn.location_id).gte('day', addDaysISO(dateStr, -1)).lte('day', dateStr).limit(MAX_DEVICES * 2)
  if (eErr) logWarn(MODULE, 'energy load failed', { locationId: conn.location_id, error: eErr.message })
  else {
    const latest = new Map()
    for (const r of eRows || []) if (!latest.has(r.device_id) || r.day > latest.get(r.device_id).day) latest.set(r.device_id, r)
    const upserts = []
    for (const d of devices) {
      const r = readings.get(d.device_id)
      const ch = r?.online ? r.channels.find((c) => c.channel === d.channel) : null
      if (!ch || ch.aenergy_wh == null) continue
      const next = rollDailyEnergy(latest.get(d.id) || null, { total_wh: ch.aenergy_wh, at: nowIso }, dateStr)
      if (next) upserts.push({ ...next, device_id: d.id, location_id: conn.location_id })
    }
    if (upserts.length) {
      const { error } = await db.from('shelly_energy_daily').upsert(upserts, { onConflict: 'device_id,day' })
      if (error) logWarn(MODULE, 'energy upsert failed', { locationId: conn.location_id, error: error.message }); else out.energyWrites = upserts.length
    }
  }

  // Plan — overrides for every adopted device, schedules for enabled ones.
  let occurrences = []
  let classOk = true
  if (devices.some((d) => d.enabled && d.schedule_mode === 'class')) {
    const occ = await loadOccurrences(db, conn.location_id, tz, nowMs)
    if (occ.ok) occurrences = occ.occurrences
    else { classOk = false; logWarn(MODULE, 'occurrence load failed — class devices skipped this tick', { locationId: conn.location_id, error: occ.error }) }
  }
  const plans = []
  for (const d of devices) {
    if (d.enabled && d.schedule_mode === 'class' && !classOk && !d.override) { out.skippedClass++; continue }
    const p = planDeviceAction(d, nowMs, dateStr, occurrences, tz)
    if (p) plans.push({ device: d, plan: p })
  }
  out.planned = plans.length

  // Write — at most one set/groups per direction; stamp only succeeded ids.
  for (const on of [true, false]) {
    const batch = plans.filter((x) => (x.plan.action === 'on') === on)
    if (!batch.length) continue
    if (now() > deadlineAt) { out.failed += batch.length; logWarn(MODULE, 'deadline reached before writes', { locationId: conn.location_id }); break }
    const res = await client.setGroups(batch.map((x) => groupId(x.device)), on)
    if (!res.ok) { out.failed += batch.length; lastKind = res.kind; if (res.kind === 'auth') auth = true; continue }
    anyOk = true
    for (const x of batch) {
      const gid = groupId(x.device)
      if (res.failed[gid]) { out.failed++; logWarn(MODULE, 'command failed', { deviceId: x.device.id, code: res.failed[gid] }); continue }
      const { error } = await db.from('shelly_devices')
        .update({ last_applied: { key: x.plan.key, action: x.plan.action, reason: x.plan.reason, at: nowIso }, updated_at: nowIso })
        .eq('id', x.device.id)
      if (error) { out.failed++; logWarn(MODULE, 'last_applied write failed', { deviceId: x.device.id, error: error.message }) }
      else out.applied++
    }
  }

  const patch = auth ? { status: 'action_needed', last_error: AUTH_ERROR, last_error_at: nowIso }
    : anyOk ? { status: 'connected', last_ok_at: nowIso, last_error: null }
    : { status: 'error', last_error: `Shelly unreachable (${lastKind || 'unknown'})`, last_error_at: nowIso }
  if (auth) out.authFailures++
  await markConnection(db, conn, { ...patch, updated_at: nowIso })
  return out
}

// Run-now (and toggle 'auto' after clearing the override): force-plan one
// device, push it through set/switch, stamp on success only.
export async function runNowForDevice(db, conn, device, deps = {}) {
  const { now = Date.now, makeClient = createShellyClient, loadOccurrences = loadTodayOccurrences, sleep = realSleep } = deps
  const tz = resolveTz(conn.locations?.timezone)
  const nowMs = now()
  const dateStr = dayStrInTz(nowMs, tz)
  let occurrences = []
  if (device.enabled && device.schedule_mode === 'class') {
    const occ = await loadOccurrences(db, conn.location_id, tz, nowMs)
    if (!occ.ok) return { ok: false, kind: 'occurrences', error: occ.error }
    occurrences = occ.occurrences
  }
  const plan = planDeviceAction(device, nowMs, dateStr, occurrences, tz, { force: true })
  if (!plan) return { ok: true, noop: true }
  const res = await makeClient(conn, { sleep, now }).setSwitch(device.device_id, device.channel, plan.action === 'on')
  if (!res.ok) return { ok: false, kind: res.kind, code: res.code ?? null, statusCode: res.statusCode ?? null }
  const nowIso = new Date(nowMs).toISOString()
  const { error } = await db.from('shelly_devices')
    .update({ last_applied: { key: plan.key, action: plan.action, reason: plan.reason, at: nowIso }, updated_at: nowIso })
    .eq('id', device.id)
  if (error) logWarn(MODULE, 'run-now stamp failed', { deviceId: device.id, error: error.message })
  return { ok: true, action: plan.action, reason: plan.reason }
}
```

- [ ] **Step 4: Run the tests under both zones**

Run: `TZ=Europe/Dublin npx vitest run src/lib/shelly && TZ=America/New_York npx vitest run src/lib/shelly`
Expected: PASS both (all five Shelly suites).

- [ ] **Step 5: Commit**

```bash
git add src/lib/shelly/reconcile.js src/lib/shelly/reconcile.test.js
git commit -m "SHELLY.8 — per-location reconcile: batched reads, energy roll, exactly-once writes, account-grouped pacing"
```

---
## Task 9: Cron route, `vercel.json` entry, guardrail arming

**Files:**
- Create: `src/app/api/cron/shelly-reconcile/route.js`
- Modify: `vercel.json` (the `crons` array, next to the `sonos-reconcile` entry at line ~202)
- Modify: `eslint.guardrails.config.mjs` (the `files` array of the `no-unchecked-supabase-write` block, after `'src/app/api/registrations/**'`)
- Test: `tests/vercel-crons.test.js` (existing — it requires a route file for every cron entry)

- [ ] **Step 1: Write the route**

```js
// src/app/api/cron/shelly-reconcile/route.js
// SHELLY.9 — Vercel cron, every minute. Reads every Shelly-connected
// location's device state, rolls energy, and applies schedule windows and
// manual overrides exactly once each. runShellyReconcile is the tested body;
// this is a thin CRON_SECRET-guarded wrapper, same skeleton as sonos-reconcile.
//
// Dormant by construction: zero shelly_connections rows → { ok:true,
// locations:0 } and the heartbeat still stamps, so a deploy ahead of the first
// connection never pages.
//
// Auth: CRON_SECRET.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { runShellyReconcile } from '@/lib/shelly/reconcile'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// Worst case per account ≈ 7 paced calls × (1 s gap + 8 s timeout); accounts
// run 4 in parallel and the run itself stops issuing calls after 90 s.
export const maxDuration = 120

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  const db = createServerClient()
  const out = await runShellyReconcile(db)

  // Counters ride into cron_heartbeats.last_outcome so ops can tell "ran,
  // 0 connections" from "ran, 12 failed" without opening the logs.
  await stampHeartbeat('shelly-reconcile', out).catch((err) =>
    logWarn('cron-shelly-reconcile', 'heartbeat failed', { err }))

  return NextResponse.json({ success: out.ok !== false, ...out })
}
```

- [ ] **Step 2: Register the cron**

In `vercel.json`, directly after the line `{ "path": "/api/cron/sonos-reconcile", "schedule": "* * * * *" },` add:

```json
    { "path": "/api/cron/shelly-reconcile", "schedule": "* * * * *" },
```

- [ ] **Step 3: Arm the guardrail for the new area**

In `eslint.guardrails.config.mjs`, inside the `no-unchecked-supabase-write` block's `files` array, after `'src/app/api/registrations/**',` add:

```js
      // SHELLY.9 — new area, clean by construction. The reconcile's
      // last_applied stamps and the (PR 2) toggle/connection writes are
      // exactly the kind that would otherwise report success on a failed
      // write. Armed from day one; PR 2 adds 'src/app/api/shelly/**'.
      'src/lib/shelly/**',
      'src/app/api/cron/shelly-reconcile/route.js',
```

- [ ] **Step 4: Verify the three gates that see these files**

Run: `npx vitest run tests/vercel-crons.test.js && npm run check:route-guards && npm run check:guardrails`
Expected: all PASS — the crons test finds the new route file; route-guards sees `CRON_SECRET` in it; guardrails reports zero bare writes under `src/lib/shelly/**`.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/cron/shelly-reconcile/route.js vercel.json eslint.guardrails.config.mjs
git commit -m "SHELLY.9 — shelly-reconcile cron route, vercel schedule, guardrail armed for the area"
```

---

## Task 10: Migrations 562 (tables) and 563 (heartbeat)

**Files:**
- Create: `supabase/migrations/562_shelly_control_integration.sql`
- Create: `supabase/migrations/563_shelly_reconcile_heartbeat.sql`

- [ ] **Step 1: Write migration 562**

```sql
-- SHELLY.10 — Shelly Cloud relay/plug control: per-location cloud connection,
-- adopted devices (one row per relay CHANNEL), daily energy per channel.
--
-- Apply any time: nothing reads these tables until the SHELLY deploy lands.
-- The cron heartbeat is deliberately NOT here — see 563, which must follow
-- the deploy that adds /api/cron/shelly-reconcile (the health check 503s on
-- a stale row; mig 561's header explains the trap).
--
-- Shape mirrors mig 560 (sonos_*): surrogate id + location_id NOT NULL UNIQUE
-- on the connection. Writes are service-role throughout (cron + staff routes
-- that authorise in app code), so there are no write policies — only
-- per-command RESTRICTIVE denials, never FOR ALL (the mig 483/485 class).
--
-- Transport note: the connection row IS the configuration (no env vars, no
-- tri-state). A future Integrator-API swap changes src/lib/shelly/client.js
-- only; nothing here names the transport.

CREATE TABLE public.shelly_connections (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id          uuid NOT NULL UNIQUE REFERENCES public.locations(id) ON DELETE CASCADE,
  host                 text NOT NULL,
  auth_key             text NOT NULL,
  auth_key_fingerprint text NOT NULL,
  key_hint             text NOT NULL,
  status               text NOT NULL DEFAULT 'connected',
  last_ok_at           timestamptz,
  last_error           text,
  last_error_at        timestamptz,
  linked_by            uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shelly_connections_status_check
    CHECK (status IN ('connected','action_needed','error')),
  -- Operator-supplied host the SERVER will fetch: an SSRF surface. App code
  -- normalises a pasted URL to its hostname; this is the backstop.
  CONSTRAINT shelly_connections_host_check
    CHECK (host ~ '^shelly-[a-z0-9-]+\.shelly\.cloud$'),
  CONSTRAINT shelly_connections_fingerprint_check
    CHECK (auth_key_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT shelly_connections_key_hint_check
    CHECK (char_length(key_hint) BETWEEN 1 AND 4)
);

-- NOT unique, on purpose — see the column comment.
CREATE INDEX shelly_connections_fingerprint_idx
  ON public.shelly_connections (auth_key_fingerprint);

COMMENT ON TABLE public.shelly_connections IS
  'SHELLY.10 — one Shelly Cloud account per location. The row is the config: zero rows = integration dormant, the cron still stamps its heartbeat.';
COMMENT ON COLUMN public.shelly_connections.location_id IS
  'UNIQUE: one location = one Shelly account. NOT the PK (mig 560 rationale): routes read by location_id and write back by id.';
COMMENT ON COLUMN public.shelly_connections.host IS
  'Per-account API host from the Shelly app (e.g. shelly-103-eu.shelly.cloud). Can change; the owner re-pastes. Hostname only — no scheme, port or path.';
COMMENT ON COLUMN public.shelly_connections.auth_key IS
  'Shelly Cloud auth key, stored plain (house pattern: whatsapp_numbers.access_token, sonos_connections.refresh_token; at-rest encryption is Supabase''s). NEVER selected into a response or a log line — routes select key_hint instead. Rotates whenever the owner changes their Shelly password: the old key starts failing and the cron flips status to action_needed.';
COMMENT ON COLUMN public.shelly_connections.auth_key_fingerprint IS
  'sha256(auth_key) hex. Deliberately NOT UNIQUE: an owner with two studios may run both on one Shelly account. App code (classifyFingerprintClash) refuses linking a key already linked at a location in a DIFFERENT organization — mirrors chooseTenantToBind (xero/tenant-binding.js). Physical isolation lives on shelly_devices (device_id, channel) UNIQUE.';
COMMENT ON COLUMN public.shelly_connections.key_hint IS
  'Last 4 chars of auth_key, so the UI can show "••••abcd" without the route ever selecting the key.';
COMMENT ON COLUMN public.shelly_connections.status IS
  'connected = last tick had at least one 2xx; action_needed = auth failure (owner must re-paste; the cron retries every 15 min until then); error = every call failed for a non-auth reason (network/429/5xx) — retried every tick.';

CREATE TABLE public.shelly_devices (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id    uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  device_id      text NOT NULL,
  channel        smallint NOT NULL DEFAULT 0,
  name           text,
  model          text,
  gen            smallint,
  zone           text,
  enabled        boolean NOT NULL DEFAULT false,
  schedule_mode  text NOT NULL DEFAULT 'none',
  fixed_windows  jsonb NOT NULL DEFAULT '[]'::jsonb,
  class_rule     jsonb NOT NULL DEFAULT '{}'::jsonb,
  override       jsonb,
  last_applied   jsonb,
  last_state     jsonb,
  last_seen_at   timestamptz,
  adopted_by     uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shelly_devices_schedule_mode_check
    CHECK (schedule_mode IN ('none','fixed','class')),
  CONSTRAINT shelly_devices_channel_check CHECK (channel BETWEEN 0 AND 15),
  -- Gen2+ ids are 12-hex MACs; kept loose (lowercase, no whitespace) so an
  -- unexpected id form fails in app code with a readable message, not as a
  -- constraint violation at adopt time.
  CONSTRAINT shelly_devices_device_id_check
    CHECK (device_id = lower(device_id) AND device_id ~ '^[0-9a-z_-]{4,64}$'),
  -- GLOBAL, not per-location: the whatsapp_numbers.phone_number_id (mig 176)
  -- / xero_connections_tenant_id_unique (mig 554) pattern. One physical relay
  -- channel serves exactly one location; the DB refuses what code forgets.
  CONSTRAINT shelly_devices_device_channel_unique UNIQUE (device_id, channel)
);

CREATE INDEX shelly_devices_location_idx ON public.shelly_devices (location_id);

COMMENT ON CONSTRAINT shelly_devices_device_channel_unique ON public.shelly_devices IS
  'SHELLY.10 — a relay channel belongs to one location, never two. Adopting a device already adopted elsewhere 23505s; the adopt route maps that to "already linked at another location" without naming it.';
COMMENT ON COLUMN public.shelly_devices.device_id IS
  'Shelly Cloud device id (12-hex MAC, lowercased). Identity for v2 get/set; set/groups addresses "<device_id>_<channel>".';
COMMENT ON COLUMN public.shelly_devices.channel IS
  'Relay channel (switch:N). Single-relay devices are 0; a Pro 4PM adopts as up to four rows sharing device_id.';
COMMENT ON COLUMN public.shelly_devices.gen IS
  'Device generation as reported by the cloud. v1 supports gen >= 2 only (Gen1 relays[]/meters[] shape is refused at discovery).';
COMMENT ON COLUMN public.shelly_devices.enabled IS
  'Schedule on/off. A live override is applied to EVERY adopted row, enabled or not (a manual action is not the schedule); windows only when enabled. Disabled rows still get their state refreshed.';
COMMENT ON COLUMN public.shelly_devices.fixed_windows IS
  '[{days:[1..7], on:"HH:MM", off:"HH:MM"}] — wall-clock in locations.timezone (off < on spans midnight). Consumed by resolveServeWindows(device, dateStr, occurrences, tz).';
COMMENT ON COLUMN public.shelly_devices.class_rule IS
  '{lead_min, lag_min} for schedule_mode=class; defaults 15/10. Class mode follows the LOCATION-WIDE timetable (class_occurrences has no zone) — zone is a label.';
COMMENT ON COLUMN public.shelly_devices.override IS
  '{state:"on"|"off", until:iso, set_by:uuid, set_at:iso}. Wins over the schedule while until > now. Applied by the cron EXACTLY ONCE (keyed "ov:<set_at>") so a failed direct toggle self-heals; the toggle route also fires set/switch directly. Default until = next local midnight. On expiry the schedule resumes: outside a window that means one "off", inside it one "on". mode none: never touched after expiry.';
COMMENT ON COLUMN public.shelly_devices.last_applied IS
  '{key, action:"on"|"off", reason, at}. Boundary exactly-once (Sonos planAction model): key "w:<on_at ms>" for windows, "ov:<set_at>" for overrides, "run:<ms>" for run-now. Keys are STRINGS by design — no number/string jsonb round-trip ambiguity (the Sonos toMs class). Humans win between boundaries: a physical press is never stamped and never undone. Not stamped on a failed command so the next tick retries (a late on/off is correct for a relay).';
COMMENT ON COLUMN public.shelly_devices.last_state IS
  '{online, output, apower, aenergy_wh, temperature_c, source, at} from the last successful cloud read. online=false keeps the previous output/apower and does not advance last_seen_at.';

CREATE TABLE public.shelly_energy_daily (
  device_id       uuid NOT NULL REFERENCES public.shelly_devices(id) ON DELETE CASCADE,
  location_id     uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  day             date NOT NULL,
  wh_start        numeric(14,3) NOT NULL,
  wh_last         numeric(14,3) NOT NULL,
  wh_total        numeric(14,3) NOT NULL DEFAULT 0,
  samples         integer NOT NULL DEFAULT 0,
  resets          integer NOT NULL DEFAULT 0,
  first_sample_at timestamptz NOT NULL,
  last_sample_at  timestamptz NOT NULL,
  PRIMARY KEY (device_id, day),
  CONSTRAINT shelly_energy_daily_nonneg_check
    CHECK (wh_start >= 0 AND wh_last >= 0 AND wh_total >= 0 AND samples >= 0 AND resets >= 0)
);

CREATE INDEX shelly_energy_daily_location_day_idx
  ON public.shelly_energy_daily (location_id, day DESC);

COMMENT ON TABLE public.shelly_energy_daily IS
  'SHELLY.10 — per-channel daily consumption rolled from the monotonic aenergy.total (Wh) counter by the per-minute cron. READ PER DEVICE (<= 31 rows for 30 days). A location-wide 30-day read is 50 x 30 = 1,500 rows — over the 1k PostgREST cap — so it must .range()-paginate or aggregate in SQL.';
COMMENT ON COLUMN public.shelly_energy_daily.device_id IS
  'FK to shelly_devices.id (the ROW, one per channel) — not the Shelly hex device_id.';
COMMENT ON COLUMN public.shelly_energy_daily.day IS
  'Calendar day in locations.timezone at sample time (dayStrInTz), so a 23:30 sample under BST lands on the right day.';
COMMENT ON COLUMN public.shelly_energy_daily.wh_total IS
  'Sum of positive deltas between consecutive samples (THE figure; kWh = /1000). Not wh_last - wh_start: that breaks on a counter reset. Day N starts from day N-1''s wh_last so the midnight-straddling minute is not lost.';
COMMENT ON COLUMN public.shelly_energy_daily.resets IS
  'Counter went backwards to < half its previous value (factory reset / some firmware updates): the new total is counted from 0. A small backwards move (flash-save rollback after a power cut) is NOT a reset and counts 0.';

ALTER TABLE public.shelly_connections  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shelly_devices      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shelly_energy_daily ENABLE ROW LEVEL SECURITY;

-- Connections hold the auth key: master or owner-at-location only, and
-- client code never selects the key column (routes use service role).
CREATE POLICY shelly_connections_select ON public.shelly_connections
  FOR SELECT TO authenticated
  USING (private.auth_is_master() OR private.auth_is_owner_at(shelly_connections.location_id));
CREATE POLICY shelly_connections_deny_insert ON public.shelly_connections
  AS RESTRICTIVE FOR INSERT TO authenticated, anon WITH CHECK (false);
CREATE POLICY shelly_connections_deny_update ON public.shelly_connections
  AS RESTRICTIVE FOR UPDATE TO authenticated, anon USING (false) WITH CHECK (false);
CREATE POLICY shelly_connections_deny_delete ON public.shelly_connections
  AS RESTRICTIVE FOR DELETE TO authenticated, anon USING (false);

-- Devices and energy carry no secrets: any staff member at the location.
CREATE POLICY shelly_devices_select ON public.shelly_devices
  FOR SELECT TO authenticated
  USING (private.auth_is_in_location(shelly_devices.location_id));
CREATE POLICY shelly_devices_deny_insert ON public.shelly_devices
  AS RESTRICTIVE FOR INSERT TO authenticated, anon WITH CHECK (false);
CREATE POLICY shelly_devices_deny_update ON public.shelly_devices
  AS RESTRICTIVE FOR UPDATE TO authenticated, anon USING (false) WITH CHECK (false);
CREATE POLICY shelly_devices_deny_delete ON public.shelly_devices
  AS RESTRICTIVE FOR DELETE TO authenticated, anon USING (false);

CREATE POLICY shelly_energy_daily_select ON public.shelly_energy_daily
  FOR SELECT TO authenticated
  USING (private.auth_is_in_location(shelly_energy_daily.location_id));
CREATE POLICY shelly_energy_daily_deny_insert ON public.shelly_energy_daily
  AS RESTRICTIVE FOR INSERT TO authenticated, anon WITH CHECK (false);
CREATE POLICY shelly_energy_daily_deny_update ON public.shelly_energy_daily
  AS RESTRICTIVE FOR UPDATE TO authenticated, anon USING (false) WITH CHECK (false);
CREATE POLICY shelly_energy_daily_deny_delete ON public.shelly_energy_daily
  AS RESTRICTIVE FOR DELETE TO authenticated, anon USING (false);
```

- [ ] **Step 2: Write migration 563**

```sql
-- SHELLY.10 — heartbeat for /api/cron/shelly-reconcile.
--
-- SHIP ORDER: apply ONLY after the deploy that adds the cron. The health
-- check 503s on any stale cron_heartbeats row, so seeding this before the
-- route ships pages immediately (mig 561 header). Until it is applied the
-- live cron logs "stamp matched 0 rows" once a minute — harmless, and the
-- reminder that this file is still pending.
--
-- 60 + 840 = the same 900s budget as sonos-reconcile (mig 561 / 471): the
-- tick cannot commit until cloud round trips return.
INSERT INTO public.cron_heartbeats (name, last_ok_at, expected_interval_seconds, grace_seconds, notes)
VALUES (
  'shelly-reconcile',
  now(),
  60,
  840,
  'SHELLY.10 — per-minute Shelly Cloud state refresh + schedule/override application. Dormant (zero shelly_connections rows) until an owner pastes a key; still stamps.'
)
ON CONFLICT (name) DO UPDATE
  SET last_ok_at = now(),
      expected_interval_seconds = EXCLUDED.expected_interval_seconds,
      grace_seconds = EXCLUDED.grace_seconds,
      notes = EXCLUDED.notes;
```

- [ ] **Step 3: Run the migration-reading gates**

Run: `npm run check:rls-restrictive && npm run check:location-scoping`
Expected: PASS. (`check:location-scoping` now derives `shelly_connections`, `shelly_devices`, `shelly_energy_daily` from 562; the only consumer in this PR is the cron, which is path-exempt.)

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/562_shelly_control_integration.sql supabase/migrations/563_shelly_reconcile_heartbeat.sql
git commit -m "SHELLY.10 — migrations: shelly_connections / shelly_devices / shelly_energy_daily (562), heartbeat (563)"
```

---

## Task 11: CHANGELOG row and the integrations doc

**Files:**
- Modify: `docs/CHANGELOG.md` (insert a row directly under the `|---|------|-------|` header line — latest first; the next free number is **563**; migration numbers are unrelated, say so in the row)
- Modify: `docs/architecture/INTEGRATIONS.md` (new section; PR 2 expands it)

- [ ] **Step 1: Add the CHANGELOG row**

```markdown
| 563 | SHELLY.1→.10 — Shelly smart-plug backend: tz-aware engine, paced cloud client, exactly-once planner, energy roll, per-location reconcile cron (migs 562/563) | PR 1 of the per-location Shelly integration (spec `docs/superpowers/specs/2026-08-22-shelly-device-control-design.md`). Dormant until an owner pastes a key in PR 2; the cron stamps with `locations: 0` meanwhile. **Tenancy:** one Shelly account per location (`shelly_connections.location_id UNIQUE`), the key fingerprint deliberately NOT unique (same-org studio sharing is legitimate; cross-org refusal is app code), and `shelly_devices (device_id, channel)` UNIQUE **globally** so a relay channel can never serve two locations. **Command model** = boundary exactly-once (Sonos `planAction`) with string keys, plus a two-way override applied once for every adopted device; failed commands are never stamped so a late on/off self-heals; a class-occurrence LOAD ERROR skips class devices rather than reading as "no classes". **Rate limit** is 1 req/s per ACCOUNT, so connections are grouped by key fingerprint — accounts in parallel, same-account studios serial — with 10-id batched reads and ≤1 `set/groups` per direction. **New `src/lib/tz-time.js`** (dublin-time.js is pinned by the shared-pair test) also fixes a latent engine bug: the minute-of-day guess-and-correct was a whole day wrong for negative-offset zones. **Energy**: `wh_total` is a sum of positive deltas with reset (<½) vs rollback (small drop) handling; read per device — a location-wide 30-day read breaks the 1k cap. 563 applied only AFTER the deploy. |
```

- [ ] **Step 2: Add the INTEGRATIONS.md section** (place it after the Twilio section)

```markdown
## Shelly Cloud (smart plugs and relays)

**No env vars.** Credentials are per location: an owner or master pastes the studio's Shelly *Authorization cloud key* and account server (Shelly Smart Control app → User settings → Authorization cloud key) on Automations → Smart plugs (PR 2). The `shelly_connections` row is the configuration; with zero rows the `shelly-reconcile` cron is dormant and still stamps its heartbeat.

- **One Shelly account per location.** The same account may be linked at several locations of one organisation (an owner with two studios); a key already linked at a location in another organisation is refused. A physical relay channel (`device_id`, `channel`) can be adopted at exactly one location — enforced by the database.
- **Changing the Shelly account password invalidates the key.** The cron flips the connection to `action_needed` within a minute; the owner re-pastes the key. The account server host can also change (Shelly relocates tenants) — same repair.
- **Rate limit is 1 request/second per account.** The cron paces itself, batches reads (10 ids) and writes (`set/groups`), retries a 429 once, and serialises same-account locations.
- **Gen2+ only** (Plus/Pro/Gen3/Gen4 `switch:N` shape). Gen1 and non-switch devices (Pro 3EM) are marked unsupported at discovery.
- **Integrator API** (Shelly's consent-based multi-account model) is a parallel operator application — https://forms.office.com/e/KDxYr4K3vF or support@shelly.cloud, business email required. Swapping to it changes `src/lib/shelly/client.js` only.
- **Secrets never leave the server**: routes expose `key_hint` (last four characters) and `has_auth_key`; the client never logs a URL (the key rides in the query string).
```

- [ ] **Step 3: Commit**

```bash
git add docs/CHANGELOG.md docs/architecture/INTEGRATIONS.md
git commit -m "SHELLY.11 — changelog row and integrations doc for the Shelly backend"
```

---

## Task 12: CI mirror, build, PR

- [ ] **Step 1: Run the full CI mirror**

Run: `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:bundle-sql && npm run check:ota-paths`
Expected: every command exits 0.

- [ ] **Step 2: Run the two-zone sweep**

Run: `TZ=Europe/Dublin npx vitest run src/lib/shelly src/lib/schedule src/lib/tz-time.test.js && TZ=America/New_York npx vitest run src/lib/shelly src/lib/schedule src/lib/tz-time.test.js`
Expected: PASS both.

- [ ] **Step 3: Production build**

Run: `npm run build`
Expected: exit 0 (this is the only check that catches an unresolvable import in the new route).

- [ ] **Step 4: Apply migration 562** via Supabase MCP (`apply_migration`, project `iyvtbjjxdggiadzwwvdj` — confirm with `list_projects`), then `get_advisors` type `security`. Expected: no new ERROR-level findings. **Do NOT apply 563 yet.**

- [ ] **Step 5: Push and open the PR**

```bash
git push -u origin HEAD
gh pr create --base main --fill --title "SHELLY.1→.11 — Shelly smart-plug backend (dormant): tz-aware engine, cloud client, exactly-once reconcile, migs 562/563"
```

- [ ] **Step 6: After merge + deploy — apply 563**, then confirm `/api/cron/health-check` stays 200 and `cron_heartbeats.last_outcome` for `shelly-reconcile` reads `{"ok":true,"locations":0}`.

---

## Plan self-review (done while writing)

- **Spec coverage:** tenancy rules (562 constraints, fingerprint helper — Task 7/10), command model (Task 5), failed-command-not-stamped and class-load-error skip (Task 8), per-location tz + the day-wrap fix (Tasks 1–2), rate-limit posture (Tasks 3 + 8), energy roll (Task 6), dormant cron + heartbeat order (Tasks 9–10), secrets never in logs (Tasks 3, 7, 8 tests). Routes, page, hub card and the bundle change are PR 2 by design.
- **Type consistency:** `createShellyClient(conn, deps)` → `{get, setSwitch, setGroups, allStatus}`; results `{ok, kind, statusCode, code?, failed?}`; `planDeviceAction(device, nowMs, dateStr, occurrences, tz, {force})` → `{action, reason, key}`; `rollDailyEnergy(prevRow, {total_wh, at}, localDay)`; `reconcileLocation(db, conn, ctx)` with `ctx = {now, sleep, makeClient, loadOccurrences, deadlineAt}`; `runNowForDevice(db, conn, device, {now, makeClient, loadOccurrences, sleep})`. Column names: `host`, `auth_key`, `auth_key_fingerprint`, `key_hint`, `last_error_at` — used identically in Tasks 7, 8 and 10.
- **Placeholders:** none.

