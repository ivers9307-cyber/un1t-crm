# Sonos Control Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move studio music scheduling from the Homey Pro onto the Sonos Control API, and delete the Homey/Tapo device path.

**Architecture:** A per-minute Vercel cron reads the Sonos household's groups over the cloud Control API and applies schedule windows **exactly once per window** (volume, then `loadFavorite` on open; `pause` on close) rather than running a continuous desired-vs-actual reconcile — `loadFavorite` is not idempotent and a reconcile loop would restart the playlist every minute. Schedules target permanent player IDs and resolve the ephemeral group ID on each tick. OAuth tokens live in `sonos_connections`, one household per location.

**Tech Stack:** Next.js App Router (JS, not TS), Supabase (service-role in routes; RLS for reads), vitest, Zod, Tailwind.

**Spec:** `docs/superpowers/specs/2026-08-20-sonos-control-integration-design.md`

---

## Conventions this codebase already has — follow them

- **Tests are colocated** next to the module: `src/lib/sonos/client.js` → `src/lib/sonos/client.test.js`. Components use `.test.jsx`.
- **Run a single test file:** `npx vitest run src/lib/sonos/client.test.js`. Run everything: `npm test`.
- **Service-role API routes get no RLS**, so they authorise in app code: `getCurrentUser()` → 401, `hasPermission(user, 'device_control')` → 403, then scope every query by `user.activeLocation.id`.
- **Never-throw HTTP clients** return `{ ok, statusCode, body }` and never reject — see `src/lib/homey/client.js` for the shape being copied.
- **Secrets never appear in logs or thrown errors.** Error paths name the env var, never its value.
- **RLS: never `RESTRICTIVE ... FOR ALL`** — it silently folds away `SELECT` too. Use per-command deny policies. `npm run check:rls-restrictive` enforces this.
- **Migrations are forward-only**, numbered sequentially in `supabase/migrations/`. Latest is `555_sequence_sender_fields.sql`, so this plan uses **556** and **557**.
- **Commit style:** `TAG.N — lowercase summary of what changed`.

## File structure

**Create:**

| File | Responsibility |
|---|---|
| `src/lib/schedule/desired-state.js` | Moved from `src/lib/tapo/`. Dublin-correct window resolution. Unchanged except one additive field. |
| `src/lib/schedule/desired-state.test.js` | Moved with it. |
| `src/lib/sonos/client.js` | Config tri-state, OAuth exchange/refresh, `withFreshToken`, never-throw Control API calls. |
| `src/lib/sonos/groups.js` | Pure: `mapGroups`, `resolveGroupIds`, `planAction`. No I/O. |
| `src/lib/sonos/reconcile.js` | Orchestration: load schedules, resolve groups, fire actions, persist state. |
| `src/app/api/cron/sonos-reconcile/route.js` | Thin CRON_SECRET wrapper. |
| `src/app/api/sonos/connect/route.js` | Builds the authorize URL with signed state. |
| `src/app/api/sonos/callback/route.js` | Exchanges the code, stores household + refresh token. |
| `src/app/api/sonos/household/route.js` | Lists live players and favourites for the config UI. |
| `src/app/api/sonos/schedules/route.js` | GET list / POST create. |
| `src/app/api/sonos/schedules/[id]/route.js` | PATCH / DELETE. |
| `src/app/api/sonos/schedules/[id]/run-now/route.js` | Clears `last_applied` so the next tick re-fires. |
| `src/app/(marketing)/automations/sonos/page.js` | Server page, `device_control`-gated. |
| `src/components/automations/SonosScheduleClient.jsx` | Client UI. |
| `supabase/migrations/556_sonos_control_integration.sql` | Tables + RLS. Safe to apply any time. |
| `supabase/migrations/557_retire_homey_tapo.sql` | Heartbeat swap + drop `tapo_devices`. **Apply only AFTER the deploy.** |

**Modify:** `vercel.json` (swap the cron entry), `src/app/(marketing)/automations/page.js` (repoint the Devices link).

**Delete:** `src/lib/homey/`, `src/lib/tapo/`, `src/app/api/tapo/`, `src/app/api/cron/homey-reconcile/`, `src/app/(marketing)/automations/devices/`, `src/components/automations/TapoDevicesClient.jsx`.

---

## Phase A — Rescue the schedule engine

### Task 1: Move `desired-state.js` out of the Tapo namespace

The engine survives the Tapo cull. It carries four traps already paid for: Dublin spring-forward correctness, overnight window tails, overnight `off` re-resolved on the next calendar day, and override-checked-before-mode-none. This task is a pure move — no behaviour change — so the later deletion of `src/lib/tapo/` cannot take it with it.

**Files:**
- Create: `src/lib/schedule/desired-state.js` (moved)
- Create: `src/lib/schedule/desired-state.test.js` (moved)
- Delete: `src/lib/tapo/desired-state.js`, `src/lib/tapo/desired-state.test.js`
- Modify: `src/lib/homey/devices.js:17` (its only importer)

- [ ] **Step 1: Move both files with git so history follows**

```bash
mkdir -p src/lib/schedule
git mv src/lib/tapo/desired-state.js src/lib/schedule/desired-state.js
git mv src/lib/tapo/desired-state.test.js src/lib/schedule/desired-state.test.js
rmdir src/lib/tapo 2>/dev/null || true
```

- [ ] **Step 2: Fix the import inside the moved test**

Open `src/lib/schedule/desired-state.test.js` and change the import path from `./desired-state` — if it is already relative (`./desired-state`), no change is needed. Confirm with:

```bash
grep -n "desired-state" src/lib/schedule/desired-state.test.js
```

Expected: the import reads `from './desired-state'`. If it reads `@/lib/tapo/desired-state`, change it to `@/lib/schedule/desired-state`.

- [ ] **Step 3: Fix the one importer**

In `src/lib/homey/devices.js`, change:

```js
import { desiredState } from '@/lib/tapo/desired-state'
```

to:

```js
import { desiredState } from '@/lib/schedule/desired-state'
```

- [ ] **Step 4: Verify nothing else referenced the old path**

Run: `grep -rn "lib/tapo" src/ tests/ || echo "CLEAN"`
Expected: `CLEAN`

- [ ] **Step 5: Run the moved tests plus the Homey tests**

Run: `npx vitest run src/lib/schedule/desired-state.test.js src/lib/homey/`
Expected: PASS, same count as before the move (17 engine tests plus the Homey suites).

- [ ] **Step 6: Commit**

```bash
git add -A src/lib/schedule src/lib/tapo src/lib/homey/devices.js
git commit -m "SONOS.1 — move the schedule engine out of the tapo namespace, unchanged"
```

---

### Task 2: Carry the source window through `resolveDayWindows`

The engine returns `{on_at, off_at}` and drops the window it came from. Sonos needs that window's `volume` and `favorite_id`, so the resolved window must carry its origin. Additive only.

**Files:**
- Modify: `src/lib/schedule/desired-state.js`
- Test: `src/lib/schedule/desired-state.test.js`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/schedule/desired-state.test.js`:

```js
describe('resolveDayWindows source passthrough', () => {
  it('carries the originating window so callers can read its payload', () => {
    const device = {
      enabled: true,
      schedule_mode: 'fixed',
      fixed_windows: [
        { days: [1, 2, 3, 4, 5], on: '06:00', off: '21:30', volume: 35, favorite_id: 'fv-1' },
      ],
    }
    // 2026-08-24 is a Monday.
    const windows = resolveDayWindows(device, '2026-08-24')
    expect(windows).toHaveLength(1)
    expect(windows[0].source.volume).toBe(35)
    expect(windows[0].source.favorite_id).toBe('fv-1')
  })

  it('keeps carrying the source through the yesterday-tail path', () => {
    const device = {
      enabled: true,
      schedule_mode: 'fixed',
      // Saturday 22:00 -> Sunday 02:00. 2026-08-22 is a Saturday (ISO dow 6).
      fixed_windows: [{ days: [6], on: '22:00', off: '02:00', volume: 20, favorite_id: 'fv-late' }],
    }
    const windows = resolveServeWindows(device, '2026-08-23') // Sunday
    expect(windows).toHaveLength(1)
    expect(windows[0].source.favorite_id).toBe('fv-late')
  })
})
```

Make sure `resolveDayWindows` and `resolveServeWindows` are in the file's import list at the top — if the existing test file imports only `desiredState`, extend it:

```js
import { desiredState, resolveDayWindows, resolveServeWindows } from './desired-state'
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/lib/schedule/desired-state.test.js -t "source"`
Expected: FAIL — `Cannot read properties of undefined (reading 'volume')`.

- [ ] **Step 3: Make the minimal change**

In `src/lib/schedule/desired-state.js`, inside `resolveDayWindows`'s `fixed` branch, change:

```js
      out.push({ on_at: onAt, off_at: offAt })
```

to:

```js
      // `source` is the window this resolved pair came from. The engine
      // itself never reads it — it exists so a caller that needs the
      // window's payload (Sonos: volume + favourite) can get it without
      // re-deriving which window is active and re-doing the DST maths.
      out.push({ on_at: onAt, off_at: offAt, source: w })
```

Leave the `class` branch alone: it collapses many occurrences into one window and has no single source.

- [ ] **Step 4: Run the whole engine suite**

Run: `npx vitest run src/lib/schedule/desired-state.test.js`
Expected: PASS — the 17 pre-existing tests plus the 2 new ones. If any pre-existing test fails on a deep-equality assertion against `{on_at, off_at}`, update that assertion to `expect.objectContaining({ on_at: ..., off_at: ... })` rather than removing `source`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/schedule/desired-state.js src/lib/schedule/desired-state.test.js
git commit -m "SONOS.2 — resolved windows carry their source window"
```

---

## Phase B — Sonos client

### Task 3: Config tri-state

Same three-state contract as the Homey client: unset = dormant (never pages), partial = misconfigured (logged loudly every tick), complete = live.

**Files:**
- Create: `src/lib/sonos/client.js`
- Test: `src/lib/sonos/client.test.js`

- [ ] **Step 1: Write the failing test**

Create `src/lib/sonos/client.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { sonosConfigError, getSonosConfig } from './client'

const full = {
  SONOS_CLIENT_ID: 'abc',
  SONOS_CLIENT_SECRET: 'shhh',
  SONOS_REDIRECT_URI: 'https://crm.repset.ie/api/sonos/callback',
}

describe('sonosConfigError', () => {
  it('returns null when nothing is set (dormant, not an error)', () => {
    expect(sonosConfigError({})).toBe(null)
  })

  it('names every missing var when half-configured', () => {
    const err = sonosConfigError({ SONOS_CLIENT_ID: 'abc' })
    expect(err).toContain('SONOS_CLIENT_SECRET')
    expect(err).toContain('SONOS_REDIRECT_URI')
  })

  it('never leaks the secret value into the error', () => {
    const err = sonosConfigError({ SONOS_CLIENT_ID: 'abc', SONOS_CLIENT_SECRET: 'shhh' })
    expect(err).not.toContain('shhh')
  })

  it('rejects a non-HTTPS redirect (Sonos requires HTTPS and publicly routable)', () => {
    const err = sonosConfigError({ ...full, SONOS_REDIRECT_URI: 'http://localhost:3000/api/sonos/callback' })
    expect(err).toContain('HTTPS')
  })

  it('returns null when fully valid', () => {
    expect(sonosConfigError(full)).toBe(null)
  })
})

describe('getSonosConfig', () => {
  it('is dormant when unset', () => {
    expect(getSonosConfig({})).toBe(null)
  })

  it('reports the error object when half-set', () => {
    expect(getSonosConfig({ SONOS_CLIENT_ID: 'abc' })).toHaveProperty('error')
  })

  it('trims pasted whitespace off the credentials', () => {
    expect(getSonosConfig({ ...full, SONOS_CLIENT_ID: ' abc \n' })).toMatchObject({ clientId: 'abc' })
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/lib/sonos/client.test.js`
Expected: FAIL — `Failed to resolve import "./client"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/sonos/client.js`:

```js
// SONOS.3 — Sonos Control API config + I/O.
//
// Config is tri-state, matching the Homey client this replaces:
//   - DORMANT (all three env vars unset) — the feature isn't turned on for
//     this deploy. getSonosConfig() returns null; the cron stamps its
//     heartbeat and exits quietly. Must NEVER page: every deploy runs the
//     cron before anyone registers the integration.
//   - MISCONFIGURED (some set, or a value fails validation) — someone
//     started and got it wrong. Returns { error }; the cron logs it loudly
//     every tick, because a silent dormant-looking failure is exactly the
//     bug nobody notices until "why didn't the music come on".
//   - CONFIGURED — returns the credentials.
//
// The client secret must never appear in a log line or a thrown error.
// Every error path below names the env var, never its value.

const OAUTH_AUTHORIZE_URL = 'https://api.sonos.com/login/v3/oauth'
const OAUTH_TOKEN_URL = 'https://api.sonos.com/login/v3/oauth/access'
const API_BASE = 'https://api.ws.sonos.com/control/api/v1'
const REQUEST_TIMEOUT_MS = 8000

// Sonos names a missing User-Agent as a throttling trigger.
const USER_AGENT = 'un1t-crm/1.0 (+https://crm.repset.ie)'

const isBlank = (v) => v === undefined || v === null || String(v).trim() === ''

export { OAUTH_AUTHORIZE_URL, OAUTH_TOKEN_URL, API_BASE }

// Pure + exported for tests. null = fully unset (dormant) OR fully valid.
export function sonosConfigError(env) {
  const raw = {
    SONOS_CLIENT_ID: env.SONOS_CLIENT_ID,
    SONOS_CLIENT_SECRET: env.SONOS_CLIENT_SECRET,
    SONOS_REDIRECT_URI: env.SONOS_REDIRECT_URI,
  }
  const missing = Object.keys(raw).filter((k) => isBlank(raw[k]))

  if (missing.length === 3) return null // dormant, not an error
  if (missing.length > 0) {
    return `Sonos is half-configured — missing ${missing.join(', ')} (set all three env vars, or none)`
  }

  let u
  try {
    u = new URL(String(raw.SONOS_REDIRECT_URI).trim())
  } catch {
    return 'SONOS_REDIRECT_URI is not a valid URL'
  }
  // Sonos requires the redirect to be HTTPS and publicly routable, and to
  // match the integration manager entry exactly.
  if (u.protocol !== 'https:') {
    return 'SONOS_REDIRECT_URI must be HTTPS and publicly routable (Sonos rejects http and localhost)'
  }

  return null
}

export function getSonosConfig(env = process.env) {
  const err = sonosConfigError(env)
  if (err) return { error: err }

  const allUnset =
    isBlank(env.SONOS_CLIENT_ID) && isBlank(env.SONOS_CLIENT_SECRET) && isBlank(env.SONOS_REDIRECT_URI)
  if (allUnset) return null

  return {
    clientId: String(env.SONOS_CLIENT_ID).trim(),
    clientSecret: String(env.SONOS_CLIENT_SECRET).trim(),
    redirectUri: String(env.SONOS_REDIRECT_URI).trim(),
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/sonos/client.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/sonos/client.js src/lib/sonos/client.test.js
git commit -m "SONOS.3 — sonos config tri-state"
```

---

### Task 4: OAuth exchange and refresh

Sonos access tokens live 24 hours. **Refresh tokens do not rotate** — the same value comes back — so there is none of the Xero read-modify-write contention to guard against; only the access token and its expiry get persisted.

**Files:**
- Modify: `src/lib/sonos/client.js`
- Test: `src/lib/sonos/client.test.js`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/sonos/client.test.js`:

```js
import { vi, beforeEach, afterEach } from 'vitest'
import { buildAuthorizeUrl, exchangeCode, refreshAccessToken } from './client'

const cfg = {
  clientId: 'abc',
  clientSecret: 'shhh',
  redirectUri: 'https://crm.repset.ie/api/sonos/callback',
}

describe('buildAuthorizeUrl', () => {
  it('requests the only scope Sonos offers, with the state echoed back', () => {
    const url = new URL(buildAuthorizeUrl(cfg, 'state-123'))
    expect(url.origin + url.pathname).toBe('https://api.sonos.com/login/v3/oauth')
    expect(url.searchParams.get('client_id')).toBe('abc')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('scope')).toBe('playback-control-all')
    expect(url.searchParams.get('state')).toBe('state-123')
    expect(url.searchParams.get('redirect_uri')).toBe(cfg.redirectUri)
  })
})

describe('token calls', () => {
  beforeEach(() => { global.fetch = vi.fn() })
  afterEach(() => { vi.restoreAllMocks() })

  it('sends client credentials as HTTP Basic, not in the body', async () => {
    global.fetch.mockResolvedValue({
      ok: true, status: 200,
      text: async () => JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 86400 }),
    })
    await exchangeCode(cfg, 'the-code')
    const [, opts] = global.fetch.mock.calls[0]
    expect(opts.headers.authorization).toBe(`Basic ${Buffer.from('abc:shhh').toString('base64')}`)
    expect(String(opts.body)).not.toContain('shhh')
  })

  it('returns the parsed token payload on success', async () => {
    global.fetch.mockResolvedValue({
      ok: true, status: 200,
      text: async () => JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 86400 }),
    })
    const out = await exchangeCode(cfg, 'the-code')
    expect(out).toMatchObject({ ok: true, body: { access_token: 'at', refresh_token: 'rt' } })
  })

  it('never throws on a network failure', async () => {
    global.fetch.mockRejectedValue(new Error('ECONNRESET'))
    const out = await refreshAccessToken(cfg, 'rt')
    expect(out).toMatchObject({ ok: false, statusCode: 0, networkError: true })
  })

  it('surfaces a 400 without leaking the secret', async () => {
    global.fetch.mockResolvedValue({ ok: false, status: 400, text: async () => '{"error":"invalid_grant"}' })
    const out = await refreshAccessToken(cfg, 'rt')
    expect(out.ok).toBe(false)
    expect(out.statusCode).toBe(400)
    expect(JSON.stringify(out)).not.toContain('shhh')
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/lib/sonos/client.test.js -t "buildAuthorizeUrl"`
Expected: FAIL — `buildAuthorizeUrl is not a function`.

- [ ] **Step 3: Implement**

Append to `src/lib/sonos/client.js`:

```js
export function buildAuthorizeUrl(cfg, state) {
  const u = new URL(OAUTH_AUTHORIZE_URL)
  u.searchParams.set('client_id', cfg.clientId)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('scope', 'playback-control-all')
  u.searchParams.set('redirect_uri', cfg.redirectUri)
  u.searchParams.set('state', state)
  return u.toString()
}

// Sonos wants the client credentials as HTTP Basic, never in the form body.
function basicAuth(cfg) {
  return `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')}`
}

async function tokenCall(cfg, params) {
  try {
    const res = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        authorization: basicAuth(cfg),
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': USER_AGENT,
      },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: 'no-store',
    })
    let parsed = null
    const text = await res.text().catch(() => '')
    if (text) { try { parsed = JSON.parse(text) } catch { parsed = null } }
    return { ok: res.ok, statusCode: res.status, body: parsed }
  } catch {
    return { ok: false, statusCode: 0, networkError: true, body: null }
  }
}

export function exchangeCode(cfg, code) {
  return tokenCall(cfg, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: cfg.redirectUri,
  })
}

// Sonos does NOT rotate refresh tokens — the same value comes back every
// time. So callers persist only the access token and its expiry; there is
// no rotation race to guard against (unlike xero_connections).
export function refreshAccessToken(cfg, refreshToken) {
  return tokenCall(cfg, { grant_type: 'refresh_token', refresh_token: refreshToken })
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/sonos/client.test.js`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/sonos/client.js src/lib/sonos/client.test.js
git commit -m "SONOS.4 — sonos oauth exchange + refresh (refresh tokens do not rotate)"
```

---

### Task 5: Control API calls and `withFreshToken`

**Files:**
- Modify: `src/lib/sonos/client.js`
- Test: `src/lib/sonos/client.test.js`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/sonos/client.test.js`:

```js
import { sonosGetGroups, sonosSetGroupVolume, sonosLoadFavorite, sonosPause } from './client'

describe('control api calls', () => {
  beforeEach(() => { global.fetch = vi.fn() })
  afterEach(() => { vi.restoreAllMocks() })

  const okEmpty = { ok: true, status: 200, text: async () => '{}' }

  it('gets groups for a household with a bearer token and a user-agent', async () => {
    global.fetch.mockResolvedValue({ ok: true, status: 200, text: async () => '{"groups":[],"players":[]}' })
    const out = await sonosGetGroups('tok', 'Sonos_HH1')
    const [url, opts] = global.fetch.mock.calls[0]
    expect(url).toBe('https://api.ws.sonos.com/control/api/v1/households/Sonos_HH1/groups')
    expect(opts.headers.authorization).toBe('Bearer tok')
    expect(opts.headers['user-agent']).toBeTruthy()
    expect(out).toMatchObject({ ok: true, statusCode: 200 })
  })

  it('url-encodes a household id', async () => {
    global.fetch.mockResolvedValue(okEmpty)
    await sonosGetGroups('tok', 'HH/with slash')
    expect(global.fetch.mock.calls[0][0]).toContain('HH%2Fwith%20slash')
  })

  it('posts group volume as an integer body', async () => {
    global.fetch.mockResolvedValue(okEmpty)
    await sonosSetGroupVolume('tok', 'GRP1', 35)
    const [url, opts] = global.fetch.mock.calls[0]
    expect(url).toBe('https://api.ws.sonos.com/control/api/v1/groups/GRP1/groupVolume')
    expect(opts.method).toBe('POST')
    expect(JSON.parse(opts.body)).toEqual({ volume: 35 })
  })

  it('clamps volume into the 0-100 range Sonos accepts', async () => {
    global.fetch.mockResolvedValue(okEmpty)
    await sonosSetGroupVolume('tok', 'GRP1', 140)
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual({ volume: 100 })
    await sonosSetGroupVolume('tok', 'GRP1', -5)
    expect(JSON.parse(global.fetch.mock.calls[1][1].body)).toEqual({ volume: 0 })
  })

  it('loads a favourite and starts playback', async () => {
    global.fetch.mockResolvedValue(okEmpty)
    await sonosLoadFavorite('tok', 'GRP1', 'fv-1')
    const [url, opts] = global.fetch.mock.calls[0]
    expect(url).toBe('https://api.ws.sonos.com/control/api/v1/groups/GRP1/favorites')
    expect(JSON.parse(opts.body)).toEqual({ favoriteId: 'fv-1', playOnCompletion: true })
  })

  it('pauses a group', async () => {
    global.fetch.mockResolvedValue(okEmpty)
    await sonosPause('tok', 'GRP1')
    expect(global.fetch.mock.calls[0][0])
      .toBe('https://api.ws.sonos.com/control/api/v1/groups/GRP1/playback/pause')
  })

  it('never throws when the network dies mid-command', async () => {
    global.fetch.mockRejectedValue(new Error('ETIMEDOUT'))
    await expect(sonosPause('tok', 'GRP1')).resolves.toMatchObject({ ok: false, statusCode: 0 })
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/lib/sonos/client.test.js -t "control api"`
Expected: FAIL — `sonosGetGroups is not a function`.

- [ ] **Step 3: Implement**

Append to `src/lib/sonos/client.js`:

```js
// Never throws. Always resolves to { ok, statusCode, body }, or
// { ok: false, statusCode: 0, networkError: true, body: null } on a
// network/timeout failure — a reconcile tick must not blow up because the
// studio's line dropped.
async function apiCall(token, method, path, body) {
  try {
    const res = await fetch(API_BASE + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'user-agent': USER_AGENT,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: 'no-store',
    })
    let parsed = null
    const text = await res.text().catch(() => '')
    if (text) { try { parsed = JSON.parse(text) } catch { parsed = null } }
    return { ok: res.ok, statusCode: res.status, body: parsed }
  } catch {
    return { ok: false, statusCode: 0, networkError: true, body: null }
  }
}

const enc = (s) => encodeURIComponent(String(s))

export function sonosGetHouseholds(token) {
  return apiCall(token, 'GET', '/households')
}

// One call returns groups, players AND each group's playbackState — the
// whole read side of a reconcile tick.
export function sonosGetGroups(token, householdId) {
  return apiCall(token, 'GET', `/households/${enc(householdId)}/groups`)
}

export function sonosGetFavorites(token, householdId) {
  return apiCall(token, 'GET', `/households/${enc(householdId)}/favorites`)
}

export function sonosSetGroupVolume(token, groupId, volume) {
  // Sonos rejects >100 outright and reads any negative as 0. Clamp here so
  // a bad stored value is a quiet no-op rather than a 400 that aborts the
  // window and leaves the favourite unloaded.
  const v = Math.max(0, Math.min(100, Math.round(Number(volume) || 0)))
  return apiCall(token, 'POST', `/groups/${enc(groupId)}/groupVolume`, { volume: v })
}

export function sonosLoadFavorite(token, groupId, favoriteId) {
  return apiCall(token, 'POST', `/groups/${enc(groupId)}/favorites`, {
    favoriteId: String(favoriteId),
    playOnCompletion: true,
  })
}

export function sonosPause(token, groupId) {
  return apiCall(token, 'POST', `/groups/${enc(groupId)}/playback/pause`)
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/sonos/client.test.js`
Expected: PASS (20 tests).

- [ ] **Step 5: Add `withFreshToken` and its test**

Append the test to `src/lib/sonos/client.test.js`:

```js
import { withFreshToken } from './client'

function fakeDb(conn, captured = {}) {
  return {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: conn, error: null }) }) }),
      update: (patch) => { captured.patch = patch; return { eq: async () => ({ error: null }) } },
    }),
    _captured: captured,
  }
}

describe('withFreshToken', () => {
  beforeEach(() => { global.fetch = vi.fn() })
  afterEach(() => { vi.restoreAllMocks() })

  it('returns the stored token when it is still fresh', async () => {
    const conn = {
      id: 'c1', household_id: 'HH1', refresh_token: 'rt', access_token: 'at',
      access_token_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }
    const out = await withFreshToken(fakeDb(conn), 'loc-1', cfg)
    expect(out).toMatchObject({ ok: true, token: 'at', householdId: 'HH1' })
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('refreshes when inside the expiry margin and persists only the access token', async () => {
    const captured = {}
    const conn = {
      id: 'c1', household_id: 'HH1', refresh_token: 'rt', access_token: 'old',
      access_token_expires_at: new Date(Date.now() + 60 * 1000).toISOString(),
    }
    global.fetch.mockResolvedValue({
      ok: true, status: 200,
      text: async () => JSON.stringify({ access_token: 'new', refresh_token: 'rt', expires_in: 86400 }),
    })
    const out = await withFreshToken(fakeDb(conn, captured), 'loc-1', cfg)
    expect(out).toMatchObject({ ok: true, token: 'new' })
    expect(captured.patch.access_token).toBe('new')
    expect(captured.patch).not.toHaveProperty('refresh_token')
  })

  it('reports not-connected rather than throwing when there is no row', async () => {
    const out = await withFreshToken(fakeDb(null), 'loc-1', cfg)
    expect(out).toMatchObject({ ok: false, reason: 'not_connected' })
  })

  it('reports a revoked grant so the UI can prompt a re-link', async () => {
    const conn = {
      id: 'c1', household_id: 'HH1', refresh_token: 'rt', access_token: 'old',
      access_token_expires_at: new Date(Date.now() - 1000).toISOString(),
    }
    global.fetch.mockResolvedValue({ ok: false, status: 400, text: async () => '{"error":"invalid_grant"}' })
    const out = await withFreshToken(fakeDb(conn), 'loc-1', cfg)
    expect(out).toMatchObject({ ok: false, reason: 'refresh_failed', statusCode: 400 })
  })
})
```

Then append the implementation to `src/lib/sonos/client.js`:

```js
const REFRESH_MARGIN_MS = 5 * 60 * 1000

// Loads a location's connection and returns a usable access token,
// refreshing first if it is inside the margin. Never throws — every
// failure is a tagged result the caller can act on, because the two
// callers are a cron tick (log and move on) and a UI route (prompt a
// re-link).
export async function withFreshToken(db, locationId, cfg) {
  const { data: conn, error } = await db
    .from('sonos_connections')
    .select('*')
    .eq('location_id', locationId)
    .maybeSingle()

  if (error) return { ok: false, reason: 'db_error', message: error.message }
  if (!conn) return { ok: false, reason: 'not_connected' }

  const expiresAt = new Date(conn.access_token_expires_at || 0).getTime()
  const fresh = Number.isFinite(expiresAt) && expiresAt - Date.now() > REFRESH_MARGIN_MS
  if (fresh && conn.access_token) {
    return { ok: true, token: conn.access_token, householdId: conn.household_id, connection: conn }
  }

  const refreshed = await refreshAccessToken(cfg, conn.refresh_token)
  if (!refreshed.ok || !refreshed.body?.access_token) {
    return { ok: false, reason: 'refresh_failed', statusCode: refreshed.statusCode }
  }

  const token = refreshed.body.access_token
  const newExpiry = new Date(Date.now() + (refreshed.body.expires_in || 86400) * 1000).toISOString()

  // Only the access token and its expiry are persisted. Sonos returns the
  // SAME refresh token every time, so rewriting it would be a no-op that
  // buys a read-modify-write race for nothing.
  const { error: upErr } = await db
    .from('sonos_connections')
    .update({ access_token: token, access_token_expires_at: newExpiry, updated_at: new Date().toISOString() })
    .eq('id', conn.id)
  if (upErr) return { ok: false, reason: 'db_error', message: upErr.message }

  return { ok: true, token, householdId: conn.household_id, connection: conn }
}
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/lib/sonos/client.test.js`
Expected: PASS (24 tests).

- [ ] **Step 7: Commit**

```bash
git add src/lib/sonos/client.js src/lib/sonos/client.test.js
git commit -m "SONOS.5 — control api calls + withFreshToken"
```

---

## Phase C — Schema and planner

### Task 6: Migration 556 — tables and RLS

**Files:**
- Create: `supabase/migrations/556_sonos_control_integration.sql`

- [ ] **Step 1: Write the migration**

```sql
-- SONOS.6 — studio music moves off the Homey Pro onto the Sonos Control API.
--
-- Two tables:
--   sonos_connections — one OAuth grant per location. location_id is the
--     PRIMARY KEY, so "one location = one Sonos household" is structural
--     rather than a rule the callback is trusted to remember. This is the
--     same failure shape as the Xero tenants[0] bug (mig 554), which put
--     101 bills / ~EUR 99k into the wrong legal entity before anyone
--     noticed. Cheap to prevent up front.
--   sonos_schedules — the music windows. Several rows per location are
--     allowed so a second zone (reception vs floor) needs no migration.
--
-- Writes are service-role throughout (OAuth callback, cron, staff routes
-- that authorise in app code), so there are no write policies — only
-- per-command denials. Deliberately NOT a RESTRICTIVE ... FOR ALL, which
-- would fold away the SELECT policy too and silently return an empty set
-- (the mig 483/485 class of bug).

CREATE TABLE public.sonos_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL UNIQUE REFERENCES public.locations(id) ON DELETE CASCADE,
  household_id text NOT NULL,
  refresh_token text NOT NULL,
  access_token text,
  access_token_expires_at timestamptz,
  linked_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN public.sonos_connections.location_id IS
  'SONOS.6 — UNIQUE: one location = one Sonos household. The callback stores the household the operator picked, never households[0].';
COMMENT ON COLUMN public.sonos_connections.refresh_token IS
  'Sonos does not rotate refresh tokens — the same value is returned on every refresh, so this column is written once at link time.';

CREATE TABLE public.sonos_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT 'Studio music',
  player_ids text[] NOT NULL DEFAULT '{}',
  enabled boolean NOT NULL DEFAULT false,
  windows jsonb NOT NULL DEFAULT '[]'::jsonb,
  override jsonb,
  last_applied jsonb,
  last_state jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sonos_schedules_location_enabled_idx
  ON public.sonos_schedules (location_id) WHERE enabled;

COMMENT ON COLUMN public.sonos_schedules.player_ids IS
  'Permanent Sonos player ids (RINCON_*, MAC-derived). NEVER group ids — Sonos documents those as ephemeral, so a schedule keyed on one breaks the first time someone regroups a speaker in the app.';
COMMENT ON COLUMN public.sonos_schedules.windows IS
  '[{days:[1..7], on:"06:00", off:"21:30", volume:0-100, favorite_id:"..."}]. Consumed by resolveServeWindows in src/lib/schedule/desired-state.js as fixed_windows.';
COMMENT ON COLUMN public.sonos_schedules.last_applied IS
  '{window_on_at, action:"open"|"close", at}. loadFavorite is NOT idempotent — re-issuing it restarts the playlist — so windows are applied exactly once rather than continuously reconciled.';
COMMENT ON COLUMN public.sonos_schedules.override IS
  '{state:"off", until} — suppression only. While live the cron no-ops entirely. There is deliberately no {state:"on"}: it would have to invent a volume and favourite, and the honest source for both is a window.';

ALTER TABLE public.sonos_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sonos_schedules ENABLE ROW LEVEL SECURITY;

-- Connections hold a refresh token, so reads are master/owner only and the
-- token column is never selected by client code (routes use service-role).
CREATE POLICY sonos_connections_select ON public.sonos_connections
  FOR SELECT TO authenticated
  USING (
    private.auth_is_master()
    OR private.auth_is_owner_at(sonos_connections.location_id)
  );

CREATE POLICY sonos_connections_deny_insert ON public.sonos_connections
  AS RESTRICTIVE FOR INSERT TO authenticated, anon WITH CHECK (false);
CREATE POLICY sonos_connections_deny_update ON public.sonos_connections
  AS RESTRICTIVE FOR UPDATE TO authenticated, anon USING (false) WITH CHECK (false);
CREATE POLICY sonos_connections_deny_delete ON public.sonos_connections
  AS RESTRICTIVE FOR DELETE TO authenticated, anon USING (false);

-- Schedules carry no secrets: any staff member attached to the location
-- may read them.
CREATE POLICY sonos_schedules_select ON public.sonos_schedules
  FOR SELECT TO authenticated
  USING (private.auth_is_in_location(sonos_schedules.location_id));

CREATE POLICY sonos_schedules_deny_insert ON public.sonos_schedules
  AS RESTRICTIVE FOR INSERT TO authenticated, anon WITH CHECK (false);
CREATE POLICY sonos_schedules_deny_update ON public.sonos_schedules
  AS RESTRICTIVE FOR UPDATE TO authenticated, anon USING (false) WITH CHECK (false);
CREATE POLICY sonos_schedules_deny_delete ON public.sonos_schedules
  AS RESTRICTIVE FOR DELETE TO authenticated, anon USING (false);
```

- [ ] **Step 2: Sanity-check the RLS helpers**

Run: `grep -rh "FUNCTION private.auth_is" supabase/migrations/ | sed 's/.*FUNCTION //' | sort -u`
Expected: includes `private.auth_is_master()`, `private.auth_is_owner_at(`, and `private.auth_is_in_location(loc_id uuid)` — all three were verified present when this plan was written. Use them exactly as spelled.

- [ ] **Step 3: Check the RESTRICTIVE guard passes**

Run: `npm run check:rls-restrictive`
Expected: PASS — the deny policies are per-command, never `FOR ALL`.

- [ ] **Step 4: Commit (do not apply yet)**

```bash
git add supabase/migrations/556_sonos_control_integration.sql
git commit -m "SONOS.6 — mig 556: sonos_connections + sonos_schedules"
```

Migration 556 is safe to apply at any point — it only adds tables. It is applied via the Supabase MCP as part of the ship sequence at the end of this plan.

---

### Task 7: Group resolution

**Files:**
- Create: `src/lib/sonos/groups.js`
- Test: `src/lib/sonos/groups.test.js`

- [ ] **Step 1: Write the failing test**

Create `src/lib/sonos/groups.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { mapGroups, resolveGroupIds } from './groups'

const raw = {
  groups: [
    { id: 'GRP_A', name: 'Studio', coordinatorId: 'RINCON_1', playbackState: 'PLAYBACK_STATE_PLAYING', playerIds: ['RINCON_1', 'RINCON_2'] },
    { id: 'GRP_B', name: 'Reception', coordinatorId: 'RINCON_3', playbackState: 'PLAYBACK_STATE_IDLE', playerIds: ['RINCON_3'] },
  ],
  players: [
    { id: 'RINCON_1', name: 'Floor Left' },
    { id: 'RINCON_2', name: 'Floor Right' },
    { id: 'RINCON_3', name: 'Reception' },
  ],
}

describe('mapGroups', () => {
  it('returns groups and players in a stable shape', () => {
    const out = mapGroups(raw)
    expect(out.groups).toHaveLength(2)
    expect(out.groups[0]).toMatchObject({ id: 'GRP_A', playbackState: 'PLAYBACK_STATE_PLAYING' })
    expect(out.players).toEqual([
      { id: 'RINCON_1', name: 'Floor Left' },
      { id: 'RINCON_2', name: 'Floor Right' },
      { id: 'RINCON_3', name: 'Reception' },
    ])
  })

  it('tolerates a missing or malformed body without throwing', () => {
    expect(mapGroups(null)).toEqual({ groups: [], players: [] })
    expect(mapGroups({ groups: 'nope' })).toEqual({ groups: [], players: [] })
  })

  it('drops entries with no id', () => {
    expect(mapGroups({ groups: [{ name: 'ghost' }], players: [{ name: 'ghost' }] }))
      .toEqual({ groups: [], players: [] })
  })
})

describe('resolveGroupIds', () => {
  const { groups } = mapGroups(raw)

  it('finds the group holding a player', () => {
    expect(resolveGroupIds(groups, ['RINCON_1'])).toEqual(['GRP_A'])
  })

  it('returns each distinct group ONCE when several players share it', () => {
    // Two speakers in the same group must not produce two loadFavorite calls.
    expect(resolveGroupIds(groups, ['RINCON_1', 'RINCON_2'])).toEqual(['GRP_A'])
  })

  it('returns every distinct group when players span more than one', () => {
    expect(resolveGroupIds(groups, ['RINCON_1', 'RINCON_3'])).toEqual(['GRP_A', 'GRP_B'])
  })

  it('follows the order of player_ids, so the first player names the primary group', () => {
    expect(resolveGroupIds(groups, ['RINCON_3', 'RINCON_1'])).toEqual(['GRP_B', 'GRP_A'])
  })

  it('ignores players that are offline or unknown to the household', () => {
    expect(resolveGroupIds(groups, ['RINCON_GONE', 'RINCON_1'])).toEqual(['GRP_A'])
  })

  it('returns empty rather than throwing on junk input', () => {
    expect(resolveGroupIds(null, null)).toEqual([])
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/lib/sonos/groups.test.js`
Expected: FAIL — `Failed to resolve import "./groups"`.

- [ ] **Step 3: Implement**

Create `src/lib/sonos/groups.js`:

```js
// SONOS.7 — pure Sonos mappers + the window planner. No I/O: everything
// here takes plain data and returns plain data, so the reconcile can be
// tested with injected fakes.

import { resolveServeWindows } from '@/lib/schedule/desired-state'

const arr = (v) => (Array.isArray(v) ? v : [])

// GET /households/{id}/groups returns groups AND players AND each group's
// playbackState in one response — the whole read side of a tick.
export function mapGroups(raw) {
  return {
    groups: arr(raw?.groups)
      .filter((g) => g && typeof g.id === 'string' && g.id)
      .map((g) => ({
        id: g.id,
        name: g.name || '',
        coordinatorId: g.coordinatorId || null,
        playbackState: g.playbackState || null,
        playerIds: arr(g.playerIds).filter((p) => typeof p === 'string'),
      })),
    players: arr(raw?.players)
      .filter((p) => p && typeof p.id === 'string' && p.id)
      .map((p) => ({ id: p.id, name: p.name || '' })),
  }
}

// Player ids are permanent; group ids are ephemeral. A schedule stores the
// former and resolves the latter every tick.
//
// Dedupe matters: four speakers in one group must produce ONE group id, or
// the open action fires loadFavorite four times at the same group and the
// playlist restarts three times. Order follows player_ids, so the first
// player names the primary group.
export function resolveGroupIds(groups, playerIds) {
  const out = []
  for (const pid of arr(playerIds)) {
    const g = arr(groups).find((gr) => arr(gr.playerIds).includes(pid))
    if (g && !out.includes(g.id)) out.push(g.id)
  }
  return out
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/sonos/groups.test.js`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/sonos/groups.js src/lib/sonos/groups.test.js
git commit -m "SONOS.7 — sonos group mapping + player-to-group resolution"
```

---

### Task 8: `planAction` — the exactly-once state machine

This is the heart of the feature. Get it wrong and the studio playlist restarts every sixty seconds.

**Files:**
- Modify: `src/lib/sonos/groups.js`
- Test: `src/lib/sonos/groups.test.js`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/sonos/groups.test.js`:

```js
import { planAction } from './groups'

// 2026-08-24 is a Monday. Dublin is UTC+1 in August, so 06:00 Dublin is
// 05:00Z and 21:30 Dublin is 20:30Z.
const MONDAY = '2026-08-24'
const at = (hhmmZ) => new Date(`2026-08-24T${hhmmZ}:00Z`).getTime()
const OPEN_AT = at('05:00')

const schedule = {
  enabled: true,
  windows: [{ days: [1, 2, 3, 4, 5], on: '06:00', off: '21:30', volume: 35, favorite_id: 'fv-1' }],
  override: null,
  last_applied: null,
}

describe('planAction', () => {
  it('opens the window on the first tick inside it, carrying volume and favourite', () => {
    expect(planAction(schedule, at('05:00'), MONDAY)).toEqual({
      action: 'open', windowOnAt: OPEN_AT, volume: 35, favoriteId: 'fv-1',
    })
  })

  it('still opens on a LATER tick if the boundary minute was missed', () => {
    // A missed cron tick must self-heal. Edge-detection on playback state
    // would not: it would see the window already begun and do nothing.
    expect(planAction(schedule, at('05:07'), MONDAY)).toMatchObject({ action: 'open' })
  })

  it('does nothing once the window is applied', () => {
    const s = { ...schedule, last_applied: { window_on_at: OPEN_AT, action: 'open' } }
    expect(planAction(s, at('12:00'), MONDAY)).toBe(null)
  })

  it('does not resume music a human paused mid-window', () => {
    // The whole point of exactly-once: a coach who pauses stays paused.
    const s = { ...schedule, last_applied: { window_on_at: OPEN_AT, action: 'open' } }
    expect(planAction(s, at('14:00'), MONDAY)).toBe(null)
  })

  it('closes the window it opened, once the window has ended', () => {
    const s = { ...schedule, last_applied: { window_on_at: OPEN_AT, action: 'open' } }
    expect(planAction(s, at('20:30'), MONDAY)).toEqual({ action: 'close', windowOnAt: OPEN_AT })
  })

  it('does not close twice', () => {
    const s = { ...schedule, last_applied: { window_on_at: OPEN_AT, action: 'close' } }
    expect(planAction(s, at('20:35'), MONDAY)).toBe(null)
  })

  it('does NOT pause a window it never opened', () => {
    // Recovery after downtime spanning a whole window: pausing here would
    // silence music a coach started by hand.
    expect(planAction(schedule, at('20:35'), MONDAY)).toBe(null)
  })

  it('does nothing outside every window with no open on record', () => {
    expect(planAction(schedule, at('03:00'), MONDAY)).toBe(null)
  })

  it('does nothing when the schedule is disabled', () => {
    expect(planAction({ ...schedule, enabled: false }, at('05:00'), MONDAY)).toBe(null)
  })

  it('no-ops entirely while a suppression override is live', () => {
    const s = {
      ...schedule,
      override: { state: 'off', until: new Date(at('23:00')).toISOString() },
    }
    expect(planAction(s, at('05:00'), MONDAY)).toBe(null)
  })

  it('resumes normal service once the override expires', () => {
    const s = {
      ...schedule,
      override: { state: 'off', until: new Date(at('04:00')).toISOString() },
    }
    expect(planAction(s, at('05:00'), MONDAY)).toMatchObject({ action: 'open' })
  })

  it('does not fire on a day the window does not run', () => {
    // 2026-08-23 is a Sunday; the window is Mon-Fri.
    expect(planAction(schedule, new Date('2026-08-23T05:00:00Z').getTime(), '2026-08-23')).toBe(null)
  })

  it('treats a re-run (last_applied cleared) as unapplied', () => {
    // This is exactly what the "run now" button does.
    const s = { ...schedule, last_applied: null }
    expect(planAction(s, at('12:00'), MONDAY)).toMatchObject({ action: 'open' })
  })

  it('defaults a missing volume to a sane level rather than silence', () => {
    const s = {
      ...schedule,
      windows: [{ days: [1, 2, 3, 4, 5], on: '06:00', off: '21:30', favorite_id: 'fv-1' }],
    }
    expect(planAction(s, at('05:00'), MONDAY)).toMatchObject({ volume: 30 })
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/lib/sonos/groups.test.js -t "planAction"`
Expected: FAIL — `planAction is not a function`.

- [ ] **Step 3: Implement**

Append to `src/lib/sonos/groups.js`:

```js
const DEFAULT_VOLUME = 30

// → null | { action:'open', windowOnAt, volume, favoriteId }
//        | { action:'close', windowOnAt }
//
// Exactly-once per window, NOT desired-vs-actual. The Homey reconcile could
// run continuously because re-flipping an on plug is a no-op; loadFavorite
// is not — re-issuing it restarts the playlist from the top. So the question
// each tick is "have I already applied this window?", never "does actual
// match desired?".
//
// Three consequences, all wanted:
//   - a missed boundary tick self-heals (the next tick still sees it unapplied)
//   - a human who pauses or turns the volume down mid-window is left alone
//   - a redeploy mid-window re-reads last_applied and does nothing
export function planAction(schedule, nowMs, dateStr) {
  if (!schedule?.enabled) return null

  // Suppression override: "leave the music alone until X". Deliberately
  // no {state:'on'} — that would have to invent a volume and a favourite,
  // and the honest source for both is a window.
  const ov = schedule.override
  if (ov?.state === 'off' && ov.until && new Date(ov.until).getTime() > nowMs) return null

  // The engine is fed a device-shaped object. `enabled` is already checked
  // above, and `override` is deliberately NOT passed: override here is
  // suppression, whereas the engine would read it as a forced on/off state.
  const windows = resolveServeWindows(
    { enabled: true, schedule_mode: 'fixed', fixed_windows: arr(schedule.windows) },
    dateStr,
  )

  const last = schedule.last_applied
  const active = windows.find((w) => nowMs >= w.on_at && nowMs < w.off_at)

  if (active) {
    // Inside a window whose on_at we have already actioned — whether we
    // opened it or have since closed it — there is nothing left to do.
    if (last && last.window_on_at === active.on_at) return null
    const src = active.source || {}
    return {
      action: 'open',
      windowOnAt: active.on_at,
      volume: Number.isFinite(Number(src.volume)) ? Number(src.volume) : DEFAULT_VOLUME,
      favoriteId: src.favorite_id || null,
    }
  }

  // Outside every window. Close only what we opened: if there is no record
  // of opening, a pause here would silence music somebody started by hand
  // (the case where the CRM was down for a whole window and came back after).
  if (last?.action === 'open') return { action: 'close', windowOnAt: last.window_on_at }

  return null
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/sonos/groups.test.js`
Expected: PASS (23 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/sonos/groups.js src/lib/sonos/groups.test.js
git commit -m "SONOS.8 — exactly-once-per-window planner (loadFavorite is not idempotent)"
```

---

## Phase D — Reconcile and cron

### Task 9: Reconcile orchestration

**Files:**
- Create: `src/lib/sonos/reconcile.js`
- Test: `src/lib/sonos/reconcile.test.js`

- [ ] **Step 1: Write the failing test**

Create `src/lib/sonos/reconcile.test.js`:

```js
import { describe, it, expect, vi } from 'vitest'
import { runSonosReconcile } from './reconcile'

const MONDAY_0500Z = new Date('2026-08-24T05:00:00Z').getTime()
const OPEN_AT = MONDAY_0500Z

const groupsBody = {
  groups: [{ id: 'GRP_A', name: 'Studio', playbackState: 'PLAYBACK_STATE_IDLE', playerIds: ['RINCON_1'] }],
  players: [{ id: 'RINCON_1', name: 'Floor' }],
}

function makeDb(schedules) {
  const updates = []
  return {
    updates,
    from(table) {
      if (table === 'sonos_schedules') {
        return {
          select: () => ({ eq: () => ({ limit: async () => ({ data: schedules, error: null }) }) }),
          update(patch) {
            return { eq: async (col, id) => { updates.push({ id, patch }); return { error: null } } }
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
}

const baseSchedule = {
  id: 's1',
  location_id: 'loc-1',
  enabled: true,
  player_ids: ['RINCON_1'],
  windows: [{ days: [1, 2, 3, 4, 5], on: '06:00', off: '21:30', volume: 35, favorite_id: 'fv-1' }],
  override: null,
  last_applied: null,
}

const deps = (over = {}) => ({
  now: () => MONDAY_0500Z,
  getConfig: () => ({ clientId: 'a', clientSecret: 'b', redirectUri: 'https://x/cb' }),
  getToken: async () => ({ ok: true, token: 'tok', householdId: 'HH1' }),
  getGroups: async () => ({ ok: true, statusCode: 200, body: groupsBody }),
  setVolume: vi.fn(async () => ({ ok: true, statusCode: 200 })),
  loadFavorite: vi.fn(async () => ({ ok: true, statusCode: 200 })),
  pause: vi.fn(async () => ({ ok: true, statusCode: 200 })),
  ...over,
})

describe('runSonosReconcile', () => {
  it('skips quietly when the integration is dormant', async () => {
    const out = await runSonosReconcile(makeDb([]), deps({ getConfig: () => null }))
    expect(out).toMatchObject({ skipped: true, reason: 'unconfigured' })
  })

  it('reports misconfiguration loudly rather than looking dormant', async () => {
    const out = await runSonosReconcile(makeDb([]), deps({ getConfig: () => ({ error: 'half set' }) }))
    expect(out).toMatchObject({ skipped: true, reason: 'misconfigured' })
  })

  it('sets volume BEFORE loading the favourite', async () => {
    const d = deps()
    const order = []
    d.setVolume = vi.fn(async () => { order.push('volume'); return { ok: true, statusCode: 200 } })
    d.loadFavorite = vi.fn(async () => { order.push('favorite'); return { ok: true, statusCode: 200 } })
    await runSonosReconcile(makeDb([baseSchedule]), d)
    // Volume last would play the first seconds at the previous window's level.
    expect(order).toEqual(['volume', 'favorite'])
    expect(d.setVolume).toHaveBeenCalledWith('tok', 'GRP_A', 35)
    expect(d.loadFavorite).toHaveBeenCalledWith('tok', 'GRP_A', 'fv-1')
  })

  it('records last_applied so the next tick is a no-op', async () => {
    const db = makeDb([baseSchedule])
    await runSonosReconcile(db, deps())
    expect(db.updates[0].patch.last_applied).toMatchObject({ window_on_at: OPEN_AT, action: 'open' })
    expect(db.updates[0].patch.last_state).toMatchObject({ group_id: 'GRP_A' })
  })

  it('does NOT mark the window applied when the favourite failed to load', async () => {
    // Otherwise a transient failure silently costs the whole window.
    const d = deps({ loadFavorite: vi.fn(async () => ({ ok: false, statusCode: 500 })) })
    const db = makeDb([baseSchedule])
    const out = await runSonosReconcile(db, d)
    expect(db.updates.find((u) => u.patch.last_applied)).toBeUndefined()
    expect(out.failed).toBe(1)
  })

  it('treats a 499 on pause as benign — an idle group is already stopped', async () => {
    const closing = {
      ...baseSchedule,
      last_applied: { window_on_at: OPEN_AT, action: 'open' },
    }
    const d = deps({
      now: () => new Date('2026-08-24T20:30:00Z').getTime(),
      pause: vi.fn(async () => ({ ok: false, statusCode: 499, body: { errorCode: 'ERROR_PLAYBACK_NO_CONTENT' } })),
    })
    const db = makeDb([closing])
    const out = await runSonosReconcile(db, d)
    expect(db.updates[0].patch.last_applied).toMatchObject({ action: 'close' })
    expect(out.failed).toBe(0)
  })

  it('writes nothing and reports sonosDown when the groups read fails', async () => {
    const db = makeDb([baseSchedule])
    const out = await runSonosReconcile(db, deps({ getGroups: async () => ({ ok: false, statusCode: 0 }) }))
    expect(db.updates).toHaveLength(0)
    expect(out).toMatchObject({ ok: true, sonosDown: true })
  })

  it('surfaces a revoked grant without throwing', async () => {
    const out = await runSonosReconcile(
      makeDb([baseSchedule]),
      deps({ getToken: async () => ({ ok: false, reason: 'refresh_failed', statusCode: 400 }) }),
    )
    expect(out).toMatchObject({ ok: true })
    expect(out.tokenFailures).toBe(1)
  })

  it('reads the household ONCE for several schedules at the same location', async () => {
    const getGroups = vi.fn(async () => ({ ok: true, statusCode: 200, body: groupsBody }))
    const two = [baseSchedule, { ...baseSchedule, id: 's2', name: 'Reception' }]
    await runSonosReconcile(makeDb(two), deps({ getGroups }))
    expect(getGroups).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/lib/sonos/reconcile.test.js`
Expected: FAIL — `Failed to resolve import "./reconcile"`.

- [ ] **Step 3: Implement**

Create `src/lib/sonos/reconcile.js`:

```js
// SONOS.9 — reconcile orchestration. All I/O is injected so this is
// testable with fakes (house pattern: zoom/reconcile.orchestrator.test.js).

import { logWarn } from '@/lib/log'
import { getSonosConfig, withFreshToken, sonosGetGroups, sonosSetGroupVolume, sonosLoadFavorite, sonosPause } from './client'
import { mapGroups, resolveGroupIds, planAction } from './groups'
// dublinDayStr(instant), NOT dublinTodayStr() — the latter takes no
// argument and always reads the real clock, which would quietly ignore an
// injected `now` and make these tests pass or fail depending on what day
// they are run.
import { dublinDayStr } from '@/lib/dublin-time'

const MODULE = 'sonos-reconcile'

// Pausing a group that has nothing loaded returns 499
// ERROR_PLAYBACK_NO_CONTENT. That is the desired end state, not a failure —
// treat it as success or every close-window tick retries forever.
const pauseSucceeded = (res) => res.ok || res.statusCode === 499

export async function runSonosReconcile(db, deps = {}) {
  const {
    now = () => Date.now(),
    getConfig = () => getSonosConfig(),
    getToken = withFreshToken,
    getGroups = sonosGetGroups,
    setVolume = sonosSetGroupVolume,
    loadFavorite = sonosLoadFavorite,
    pause = sonosPause,
  } = deps

  const cfg = getConfig()
  if (!cfg) return { skipped: true, reason: 'unconfigured' }
  if (cfg.error) {
    logWarn(MODULE, 'misconfigured', { error: cfg.error })
    return { skipped: true, reason: 'misconfigured' }
  }

  const { data: schedules, error } = await db
    .from('sonos_schedules')
    .select('*')
    .eq('enabled', true)
    .limit(200)
  if (error) {
    logWarn(MODULE, 'schedule load failed', { error: error.message })
    return { ok: false }
  }
  if (!schedules?.length) return { ok: true, applied: 0, failed: 0 }

  const nowMs = now()
  const dateStr = dublinDayStr(nowMs)
  const nowIso = new Date(nowMs).toISOString()

  // Group by location: one household read serves every schedule there.
  const byLocation = new Map()
  for (const s of schedules) {
    if (!byLocation.has(s.location_id)) byLocation.set(s.location_id, [])
    byLocation.get(s.location_id).push(s)
  }

  let applied = 0
  let failed = 0
  let tokenFailures = 0
  let sonosDown = false

  for (const [locationId, rows] of byLocation) {
    const tok = await getToken(db, locationId, cfg)
    if (!tok.ok) {
      tokenFailures++
      logWarn(MODULE, 'token unavailable', { locationId, reason: tok.reason, statusCode: tok.statusCode })
      continue
    }

    const res = await getGroups(tok.token, tok.householdId)
    if (!res.ok) {
      // 401 = revoked/rotated grant; 0 = network. Either way: no DB writes
      // this tick. last_state staleness is the alert, not a thrown error.
      sonosDown = true
      logWarn(MODULE, 'sonos unreachable', { locationId, statusCode: res.statusCode })
      continue
    }

    const { groups } = mapGroups(res.body)

    for (const schedule of rows) {
      const plan = planAction(schedule, nowMs, dateStr)
      if (!plan) continue

      const groupIds = resolveGroupIds(groups, schedule.player_ids)
      if (!groupIds.length) {
        failed++
        logWarn(MODULE, 'no group for schedule players', { scheduleId: schedule.id })
        continue
      }

      let allOk = true
      for (const groupId of groupIds) {
        if (plan.action === 'open') {
          // Volume first: after loadFavorite, the opening seconds would
          // play at the previous window's level.
          const v = await setVolume(tok.token, groupId, plan.volume)
          if (!v.ok) { allOk = false; logWarn(MODULE, 'setVolume failed', { groupId, statusCode: v.statusCode }); continue }
          const f = await loadFavorite(tok.token, groupId, plan.favoriteId)
          if (!f.ok) { allOk = false; logWarn(MODULE, 'loadFavorite failed', { groupId, statusCode: f.statusCode }) }
        } else {
          const p = await pause(tok.token, groupId)
          if (!pauseSucceeded(p)) { allOk = false; logWarn(MODULE, 'pause failed', { groupId, statusCode: p.statusCode }) }
        }
      }

      if (!allOk) {
        // Deliberately do NOT stamp last_applied: leaving the window
        // unapplied means the next tick retries it, which is what a
        // transient 5xx deserves. Stamping it would cost the whole window.
        failed++
        continue
      }

      const primary = groupIds[0]
      const group = groups.find((g) => g.id === primary)
      const { error: upErr } = await db
        .from('sonos_schedules')
        .update({
          last_applied: { window_on_at: plan.windowOnAt, action: plan.action, at: nowIso },
          last_state: { group_id: primary, playback_state: group?.playbackState || null, at: nowIso },
          updated_at: nowIso,
        })
        .eq('id', schedule.id)
      if (upErr) {
        failed++
        logWarn(MODULE, 'state write failed', { scheduleId: schedule.id, error: upErr.message })
        continue
      }
      applied++
    }
  }

  return { ok: true, applied, failed, tokenFailures, ...(sonosDown ? { sonosDown: true } : {}) }
}
```

- [ ] **Step 4: Confirm the Dublin helper takes an instant**

Run: `grep -n "export function dublinDayStr\|export function dublinTodayStr" src/lib/dublin-time.js`
Expected: `dublinDayStr(instant = Date.now())` and `dublinTodayStr()`.

**Use `dublinDayStr`, never `dublinTodayStr`.** The latter takes no argument and always reads the real clock, so passing it `nowMs` compiles, runs, and silently returns the wrong day — the reconcile tests would then pass or fail depending on the date they are run.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/lib/sonos/reconcile.test.js`
Expected: PASS (9 tests).

- [ ] **Step 6: Commit**

```bash
git add src/lib/sonos/reconcile.js src/lib/sonos/reconcile.test.js
git commit -m "SONOS.9 — sonos reconcile orchestration"
```

---

### Task 10: Cron route

**Files:**
- Create: `src/app/api/cron/sonos-reconcile/route.js`
- Modify: `vercel.json:202`

- [ ] **Step 1: Write the route**

Create `src/app/api/cron/sonos-reconcile/route.js`:

```js
// SONOS.10 — Vercel cron, every minute. Applies Sonos schedule windows
// exactly once each (volume + favourite on open, pause on close).
// runSonosReconcile is the tested body; this route is a thin
// CRON_SECRET-guarded wrapper, same skeleton as class-climate.
//
// Auth: CRON_SECRET.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { runSonosReconcile } from '@/lib/sonos/reconcile'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  const db = createServerClient()
  const out = await runSonosReconcile(db)

  await stampHeartbeat('sonos-reconcile').catch((err) =>
    logWarn('cron-sonos-reconcile', 'heartbeat failed', { err }))

  // `out.ok !== false`, not `out.ok === true`: the two `skipped` results
  // carry no `ok` key and a dormant deploy must not page. A real crash
  // throws out of runSonosReconcile and 500s here, which IS worth paging on.
  return NextResponse.json({ success: out.ok !== false, ...out })
}
```

- [ ] **Step 2: Add the cron entry**

In `vercel.json`, immediately after the `homey-reconcile` line (line 202), add:

```json
    { "path": "/api/cron/sonos-reconcile", "schedule": "* * * * *" },
```

Leave the `homey-reconcile` entry in place for now — Task 14 removes it, so that a half-shipped state never has neither cron.

- [ ] **Step 3: Verify the route guard checker passes**

Run: `npm run check:route-guards`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/cron/sonos-reconcile/route.js vercel.json
git commit -m "SONOS.10 — per-minute sonos-reconcile cron"
```

---

## Phase E — OAuth routes, config routes, UI

### Task 11: Connect and callback

**Files:**
- Create: `src/app/api/sonos/connect/route.js`
- Create: `src/app/api/sonos/callback/route.js`

- [ ] **Step 1: Write the connect route**

Create `src/app/api/sonos/connect/route.js`:

```js
// SONOS.11 — starts the OAuth link. Staff-only; the state parameter is
// signed with CRON_SECRET so the callback can prove the round trip came
// from us and can recover which location is being linked without a
// server-side session store.

import { NextResponse } from 'next/server'
import crypto from 'node:crypto'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { getSonosConfig, buildAuthorizeUrl } from '@/lib/sonos/client'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function signState(payload, secret) {
  const raw = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = crypto.createHmac('sha256', secret).update(raw).digest('base64url')
  return `${raw}.${sig}`
}

export function verifyState(state, secret) {
  const [raw, sig] = String(state || '').split('.')
  if (!raw || !sig) return null
  const expected = crypto.createHmac('sha256', secret).update(raw).digest('base64url')
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  try { return JSON.parse(Buffer.from(raw, 'base64url').toString()) } catch { return null }
}

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'device_control')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const locationId = user.activeLocation?.id
  if (!locationId) return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })

  const cfg = getSonosConfig()
  if (!cfg) return NextResponse.json({ success: false, error: 'Sonos is not configured on this deploy' }, { status: 503 })
  if (cfg.error) return NextResponse.json({ success: false, error: cfg.error }, { status: 503 })
  if (!process.env.CRON_SECRET) {
    return NextResponse.json({ success: false, error: 'CRON_SECRET is required to sign the OAuth state' }, { status: 503 })
  }

  const state = signState({ locationId, profileId: user.id, ts: Date.now() }, process.env.CRON_SECRET)
  return NextResponse.redirect(buildAuthorizeUrl(cfg, state))
}
```

- [ ] **Step 2: Write the callback route**

Create `src/app/api/sonos/callback/route.js`:

```js
// SONOS.12 — completes the OAuth link. Stores the household the operator
// is linking, one row per location.
//
// The household is read from GET /households and, when the account holds
// more than one, the operator is sent back to pick. It is NEVER
// households[0] — that is the exact shape of the Xero tenants[0] bug that
// bound three locations to one org and filed 101 bills into the wrong
// legal entity (mig 554).

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getSonosConfig, exchangeCode, sonosGetHouseholds } from '@/lib/sonos/client'
import { verifyState } from '../connect/route'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const back = (params) => NextResponse.redirect(
  `${process.env.NEXT_PUBLIC_SITE_URL || ''}/automations/sonos?${new URLSearchParams(params)}`,
)

export async function GET(request) {
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')

  if (url.searchParams.get('error')) {
    return back({ sonos: 'denied' })
  }
  if (!code || !state) return back({ sonos: 'bad_callback' })

  const cfg = getSonosConfig()
  if (!cfg || cfg.error) return back({ sonos: 'not_configured' })

  const claims = verifyState(state, process.env.CRON_SECRET || '')
  if (!claims?.locationId) return back({ sonos: 'bad_state' })

  const tokenRes = await exchangeCode(cfg, code)
  if (!tokenRes.ok || !tokenRes.body?.refresh_token) {
    logWarn('sonos-callback', 'code exchange failed', { statusCode: tokenRes.statusCode })
    return back({ sonos: 'exchange_failed' })
  }

  const accessToken = tokenRes.body.access_token
  const hhRes = await sonosGetHouseholds(accessToken)
  const households = Array.isArray(hhRes.body?.households) ? hhRes.body.households : []
  if (!households.length) return back({ sonos: 'no_household' })

  // A Sonos account with several households cannot be resolved for the
  // operator — guessing is how the wrong-entity bug happened. Ask.
  const chosen = url.searchParams.get('household_id')
  if (households.length > 1 && !chosen) {
    return back({ sonos: 'pick_household', ids: households.map((h) => h.id).join(',') })
  }
  const householdId = chosen || households[0].id
  if (!households.some((h) => h.id === householdId)) return back({ sonos: 'bad_household' })

  const db = createServerClient()
  const nowIso = new Date().toISOString()
  const { error } = await db.from('sonos_connections').upsert({
    location_id: claims.locationId,
    household_id: householdId,
    refresh_token: tokenRes.body.refresh_token,
    access_token: accessToken,
    access_token_expires_at: new Date(Date.now() + (tokenRes.body.expires_in || 86400) * 1000).toISOString(),
    linked_by: claims.profileId || null,
    updated_at: nowIso,
  }, { onConflict: 'location_id' })

  if (error) {
    logWarn('sonos-callback', 'connection write failed', { error: error.message })
    return back({ sonos: 'save_failed' })
  }

  return back({ sonos: 'connected' })
}
```

- [ ] **Step 3: Verify the guards checker still passes**

Run: `npm run check:route-guards && npm run check:secrets`
Expected: both PASS. The callback is deliberately unauthenticated (Sonos redirects the browser to it) and is protected by the signed `state` instead — if `check:route-guards` flags it, add it to that script's allowlist with the comment `OAuth callback; authorised by signed state`.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/sonos/connect src/app/api/sonos/callback
git commit -m "SONOS.11 — sonos oauth connect + callback, household never guessed"
```

---

### Task 12: Household and schedule routes

**Files:**
- Create: `src/app/api/sonos/household/route.js`
- Create: `src/app/api/sonos/schedules/route.js`
- Create: `src/app/api/sonos/schedules/[id]/route.js`
- Create: `src/app/api/sonos/schedules/[id]/run-now/route.js`

- [ ] **Step 1: Write the household route**

Create `src/app/api/sonos/household/route.js`:

```js
// SONOS.13 — live players + favourites for the config UI.
// Service-role route: authorise in app code, scope by active location.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { getSonosConfig, withFreshToken, sonosGetGroups, sonosGetFavorites } from '@/lib/sonos/client'
import { mapGroups } from '@/lib/sonos/groups'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'device_control')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const locationId = user.activeLocation?.id
  if (!locationId) return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })

  const cfg = getSonosConfig()
  if (!cfg || cfg.error) return NextResponse.json({ success: true, connected: false, reason: 'not_configured' })

  const db = createServerClient()
  const tok = await withFreshToken(db, locationId, cfg)
  if (!tok.ok) return NextResponse.json({ success: true, connected: false, reason: tok.reason })

  const [groupsRes, favRes] = await Promise.all([
    sonosGetGroups(tok.token, tok.householdId),
    sonosGetFavorites(tok.token, tok.householdId),
  ])
  if (!groupsRes.ok) {
    return NextResponse.json({ success: true, connected: true, reachable: false, statusCode: groupsRes.statusCode })
  }

  const { groups, players } = mapGroups(groupsRes.body)
  // getFavorites returns the array under `items`, NOT `favorites` — verified
  // against the reference docs. Capped at 70 by Sonos.
  const favorites = (favRes.body?.items || []).map((f) => ({ id: f.id, name: f.name || '' }))

  return NextResponse.json({ success: true, connected: true, reachable: true, groups, players, favorites })
}
```

- [ ] **Step 2: Write the schedules list/create route**

Create `src/app/api/sonos/schedules/route.js`:

```js
// SONOS.14 — schedule list + create.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

export const Window = z.object({
  days: z.array(z.number().int().min(1).max(7)).min(1),
  on: z.string().regex(HHMM),
  off: z.string().regex(HHMM),
  volume: z.number().int().min(0).max(100),
  favorite_id: z.string().min(1).max(128),
}).refine((w) => w.on !== w.off, {
  // Equal boundaries make the engine treat the window as overnight and
  // resolve a 24-hour always-on span — the exact trap the Tapo build hit.
  message: 'A window must not start and end at the same time',
})

export const SchedulePayload = z.object({
  name: z.string().min(1).max(80).optional(),
  player_ids: z.array(z.string().min(1)).max(32).optional(),
  enabled: z.boolean().optional(),
  windows: z.array(Window).max(16).optional(),
})

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'device_control')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const locationId = user.activeLocation?.id
  if (!locationId) return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })

  const db = createServerClient()
  const { data, error } = await db
    .from('sonos_schedules')
    .select('*')
    .eq('location_id', locationId)
    .order('created_at', { ascending: true })
    .limit(50)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, schedules: data || [] })
}

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'device_control')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const locationId = user.activeLocation?.id
  if (!locationId) return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })

  const parsed = SchedulePayload.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message || 'Invalid payload' }, { status: 400 })
  }

  const db = createServerClient()
  const { data, error } = await db
    .from('sonos_schedules')
    .insert({ location_id: locationId, ...parsed.data })
    .select()
    .single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, schedule: data })
}
```

- [ ] **Step 3: Write the update/delete route**

Create `src/app/api/sonos/schedules/[id]/route.js`:

```js
// SONOS.15 — schedule update + delete. Location scope is enforced on the
// WHERE clause, not just read back, so a guessed id from another location
// cannot be written.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { SchedulePayload } from '../route'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Patch = SchedulePayload.extend({
  override: z.object({
    state: z.literal('off'),
    until: z.string().datetime(),
  }).nullable().optional(),
})

async function authorise() {
  const user = await getCurrentUser()
  if (!user) return { error: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }) }
  if (!hasPermission(user, 'device_control')) {
    return { error: NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 }) }
  }
  const locationId = user.activeLocation?.id
  if (!locationId) return { error: NextResponse.json({ success: false, error: 'No active location' }, { status: 400 }) }
  return { locationId }
}

export async function PATCH(request, { params }) {
  const auth = await authorise()
  if (auth.error) return auth.error
  const { id } = await params

  const parsed = Patch.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message || 'Invalid payload' }, { status: 400 })
  }

  const db = createServerClient()
  const { data, error } = await db
    .from('sonos_schedules')
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('location_id', auth.locationId)
    .select()
    .maybeSingle()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  return NextResponse.json({ success: true, schedule: data })
}

export async function DELETE(request, { params }) {
  const auth = await authorise()
  if (auth.error) return auth.error
  const { id } = await params

  const db = createServerClient()
  const { error } = await db
    .from('sonos_schedules')
    .delete()
    .eq('id', id)
    .eq('location_id', auth.locationId)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
```

- [ ] **Step 4: Write the run-now route**

Create `src/app/api/sonos/schedules/[id]/run-now/route.js`:

```js
// SONOS.16 — "run now". Clears last_applied so the next cron tick treats
// the active window as unapplied and re-fires it (volume + favourite).
//
// Outside any window this is a no-op by construction: planAction only
// opens when a window is active, and it will not close a window it has no
// record of opening. The button recovers a window the room overrode; it is
// deliberately NOT a hidden stop control.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'

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

  const db = createServerClient()
  const { data, error } = await db
    .from('sonos_schedules')
    .update({ last_applied: null, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('location_id', locationId)
    .select('id')
    .maybeSingle()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  return NextResponse.json({ success: true })
}
```

- [ ] **Step 5: Run the guard scripts**

Run: `npm run check:route-guards && npm run check:location-scoping`
Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/sonos
git commit -m "SONOS.12 — sonos household + schedule routes"
```

---

### Task 13: Operator UI

**Files:**
- Create: `src/app/(marketing)/automations/sonos/page.js`
- Create: `src/components/automations/SonosScheduleClient.jsx`
- Modify: `src/app/(marketing)/automations/page.js`

- [ ] **Step 1: Write the server page**

Create `src/app/(marketing)/automations/sonos/page.js`:

```js
// SONOS.17 — studio music. Gated on the existing `device_control`
// permission (inherited from the retired Tapo devices page — it is already
// wired through the role templates and the nav union in layout.js, so
// repointing it beats minting an identical key).
import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import SonosScheduleClient from '@/components/automations/SonosScheduleClient'

export const dynamic = 'force-dynamic'

export default async function SonosPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'device_control')) redirect('/automations')

  const location = user.activeLocation

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-un1t-text">Studio music</h1>
        <p className="text-sm text-un1t-subtle mt-1">
          Scheduled Sonos playback for {location?.name || 'your studio'} — when the music starts, what plays, and how loud.
        </p>
      </div>
      <SonosScheduleClient locationName={location?.name || ''} />
    </div>
  )
}
```

- [ ] **Step 2: Write the client component**

Create `src/components/automations/SonosScheduleClient.jsx`:

```jsx
'use client'

// SONOS.18 — studio music config.
//
// Deliberately shows what the CRM will and will not do: the schedule acts
// at window boundaries only, so a coach who pauses or turns it down
// mid-session is left alone until the next window. That is a feature, and
// the copy says so — otherwise it reads as a bug.

import { useCallback, useEffect, useState } from 'react'

const DAYS = [
  { n: 1, label: 'Mon' }, { n: 2, label: 'Tue' }, { n: 3, label: 'Wed' },
  { n: 4, label: 'Thu' }, { n: 5, label: 'Fri' }, { n: 6, label: 'Sat' }, { n: 7, label: 'Sun' },
]

const NEW_WINDOW = { days: [1, 2, 3, 4, 5], on: '06:00', off: '21:30', volume: 30, favorite_id: '' }

export default function SonosScheduleClient({ locationName }) {
  const [household, setHousehold] = useState(null)
  const [schedule, setSchedule] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [hh, sc] = await Promise.all([
        fetch('/api/sonos/household').then((r) => r.json()),
        fetch('/api/sonos/schedules').then((r) => r.json()),
      ])
      setHousehold(hh)
      setSchedule(sc.schedules?.[0] || null)
      setError('')
    } catch (e) {
      setError(e.message || 'Could not load Sonos state')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const save = async (patch) => {
    setSaving(true)
    try {
      const res = schedule
        ? await fetch(`/api/sonos/schedules/${schedule.id}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch),
          }).then((r) => r.json())
        : await fetch('/api/sonos/schedules', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'Studio music', windows: [NEW_WINDOW], ...patch }),
          }).then((r) => r.json())
      if (!res.success) throw new Error(res.error || 'Save failed')
      setSchedule(res.schedule)
      setError('')
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const runNow = async () => {
    if (!schedule) return
    await fetch(`/api/sonos/schedules/${schedule.id}/run-now`, { method: 'POST' })
    await load()
  }

  if (loading) return <p className="text-sm text-un1t-subtle">Loading…</p>

  if (!household?.connected) {
    return (
      <div className="rounded-lg border border-un1t-border p-6 space-y-3">
        <h2 className="font-medium text-un1t-text">Connect Sonos</h2>
        <p className="text-sm text-un1t-subtle">
          {household?.reason === 'not_configured'
            ? 'Sonos is not configured on this deploy yet.'
            : `Link the Sonos account for ${locationName || 'this studio'} to schedule music.`}
        </p>
        <a
          href="/api/sonos/connect"
          className="inline-block rounded bg-un1t-text px-4 py-2 text-sm text-white"
        >
          Connect Sonos
        </a>
      </div>
    )
  }

  const windows = schedule?.windows?.length ? schedule.windows : [NEW_WINDOW]
  const setWindow = (i, patch) => {
    const next = windows.map((w, idx) => (idx === i ? { ...w, ...patch } : w))
    save({ windows: next })
  }

  return (
    <div className="space-y-6">
      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      {!household.reachable ? (
        <p className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          Connected, but the Sonos cloud is not answering right now (status {household.statusCode}).
          Schedules resume on their own when it comes back.
        </p>
      ) : null}

      <section className="rounded-lg border border-un1t-border p-4 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-medium text-un1t-text">Schedule</h2>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={!!schedule?.enabled}
              disabled={saving}
              onChange={(e) => save({ enabled: e.target.checked })}
            />
            Enabled
          </label>
        </div>

        <div>
          <p className="text-sm font-medium text-un1t-text mb-2">Speakers</p>
          <div className="flex flex-wrap gap-2">
            {(household.players || []).map((p) => {
              const on = (schedule?.player_ids || []).includes(p.id)
              return (
                <button
                  key={p.id}
                  type="button"
                  disabled={saving}
                  onClick={() => {
                    const cur = schedule?.player_ids || []
                    save({ player_ids: on ? cur.filter((x) => x !== p.id) : [...cur, p.id] })
                  }}
                  className={`rounded-full border px-3 py-1 text-sm ${on ? 'bg-un1t-text text-white' : 'border-un1t-border text-un1t-subtle'}`}
                >
                  {p.name}
                </button>
              )
            })}
          </div>
        </div>

        {windows.map((w, i) => (
          <div key={i} className="rounded border border-un1t-border p-3 space-y-3">
            <div className="flex flex-wrap gap-1">
              {DAYS.map((d) => {
                const on = w.days.includes(d.n)
                return (
                  <button
                    key={d.n}
                    type="button"
                    disabled={saving}
                    onClick={() => setWindow(i, {
                      days: on ? w.days.filter((x) => x !== d.n) : [...w.days, d.n].sort(),
                    })}
                    className={`rounded px-2 py-1 text-xs ${on ? 'bg-un1t-text text-white' : 'border border-un1t-border text-un1t-subtle'}`}
                  >
                    {d.label}
                  </button>
                )
              })}
            </div>

            <div className="flex flex-wrap items-end gap-3">
              <label className="text-sm">
                <span className="block text-un1t-subtle">On</span>
                <input type="time" defaultValue={w.on} disabled={saving}
                  onBlur={(e) => setWindow(i, { on: e.target.value })}
                  className="rounded border border-un1t-border px-2 py-1" />
              </label>
              <label className="text-sm">
                <span className="block text-un1t-subtle">Off</span>
                <input type="time" defaultValue={w.off} disabled={saving}
                  onBlur={(e) => setWindow(i, { off: e.target.value })}
                  className="rounded border border-un1t-border px-2 py-1" />
              </label>
              <label className="text-sm">
                <span className="block text-un1t-subtle">Volume {w.volume}</span>
                <input type="range" min="0" max="100" defaultValue={w.volume} disabled={saving}
                  onMouseUp={(e) => setWindow(i, { volume: Number(e.target.value) })} />
              </label>
              <label className="text-sm">
                <span className="block text-un1t-subtle">Plays</span>
                <select value={w.favorite_id || ''} disabled={saving}
                  onChange={(e) => setWindow(i, { favorite_id: e.target.value })}
                  className="rounded border border-un1t-border px-2 py-1">
                  <option value="">Choose a favourite…</option>
                  {(household.favorites || []).map((f) => (
                    <option key={f.id} value={f.id}>{f.name}</option>
                  ))}
                </select>
              </label>
            </div>
          </div>
        ))}

        <div className="flex items-center gap-3">
          <button type="button" onClick={runNow} disabled={saving || !schedule}
            className="rounded border border-un1t-border px-3 py-1.5 text-sm">
            Run now
          </button>
          {schedule?.last_applied ? (
            <span className="text-xs text-un1t-subtle">
              Last {schedule.last_applied.action} at {new Date(schedule.last_applied.at).toLocaleString('en-IE')}
            </span>
          ) : null}
        </div>

        <p className="text-xs text-un1t-subtle">
          The schedule acts when a window opens and closes, and leaves the music alone in between —
          so if someone turns it down or pauses it mid-session, it stays that way until the next window.
        </p>
      </section>
    </div>
  )
}
```

- [ ] **Step 3: Repoint the Devices link**

In `src/app/(marketing)/automations/page.js`, find the `canDevices` block at line 24 and the link it renders. Change the href from `/automations/devices` to `/automations/sonos` and the label from `Devices` to `Studio music`. Verify with:

```bash
grep -n "automations/devices\|canDevices" src/app/\(marketing\)/automations/page.js
```

Expected after the edit: no occurrence of `automations/devices`.

- [ ] **Step 4: Verify it builds**

Run: `npm run build`
Expected: exits 0. (`npm run build` is known to work locally — do not skip it on an assumption that fonts 404.)

- [ ] **Step 5: Commit**

```bash
git add "src/app/(marketing)/automations/sonos" src/components/automations/SonosScheduleClient.jsx "src/app/(marketing)/automations/page.js"
git commit -m "SONOS.13 — studio music page, devices link repointed"
```

---

## Phase F — Retire the Homey path

### Task 14: Delete the Homey and Tapo code

**Files:**
- Delete: `src/lib/homey/`, `src/app/api/tapo/`, `src/app/api/cron/homey-reconcile/`, `src/app/(marketing)/automations/devices/`, `src/components/automations/TapoDevicesClient.jsx`
- Modify: `vercel.json`

- [ ] **Step 1: Delete the files**

```bash
git rm -r src/lib/homey src/app/api/tapo src/app/api/cron/homey-reconcile
git rm -r "src/app/(marketing)/automations/devices"
git rm src/components/automations/TapoDevicesClient.jsx
```

- [ ] **Step 2: Remove the cron entry**

In `vercel.json`, delete this line:

```json
    { "path": "/api/cron/homey-reconcile", "schedule": "* * * * *" },
```

- [ ] **Step 3: Verify nothing still references the deleted code**

Run: `grep -rn "homey\|tapo\|Tapo\|HOMEY_" src/ tests/ vercel.json --include=* -i | grep -v "sonos" || echo "CLEAN"`
Expected: `CLEAN`. Any hit is a dangling import that must be removed before the build will pass.

- [ ] **Step 4: Full verification**

Run: `npm test`
Expected: PASS, with the Homey and Tapo suites gone and the Sonos suites present.

Run: `npm run lint && npm run build`
Expected: lint 0 errors, build exits 0.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "SONOS.14 — delete the homey/tapo device path"
```

---

### Task 15: Migration 557 — heartbeat swap and table drop

**⚠️ Apply this migration only AFTER the deploy that removes the `homey-reconcile` cron and adds `sonos-reconcile`.** The health check 503s on any stale heartbeat row, so a `sonos-reconcile` row seeded before its cron exists reads as an outage, and a `homey-reconcile` row left behind after its cron is deleted reads as a dead cron forever. This is the mig-447 ship-order trap in both directions.

**Files:**
- Create: `supabase/migrations/557_retire_homey_tapo.sql`

- [ ] **Step 1: Write the migration**

```sql
-- SONOS.15 — retire the Homey path now that studio music runs on the Sonos
-- Control API.
--
-- SHIP ORDER: apply ONLY after the deploy that removes /api/cron/
-- homey-reconcile and adds /api/cron/sonos-reconcile. The health check 503s
-- on any stale cron_heartbeats row, so seeding sonos-reconcile before its
-- cron ships would page immediately, and leaving homey-reconcile behind
-- after its cron is gone would page forever.
--
-- What the Homey held, measured 2026-08-20 before removal: 50 tapo_devices
-- rows, ZERO with a schedule (schedule_mode = 'none' across the board), and
-- 46 unreachable since 2026-08-10. Nothing automated depended on it.

-- 1. The new cron's heartbeat. last_ok_at seeded to now() so the first tick
--    has a budget to land in rather than starting stale.
INSERT INTO public.cron_heartbeats (name, last_ok_at, expected_interval_seconds, grace_seconds, notes)
VALUES (
  'sonos-reconcile',
  now(),
  60,
  900,
  'SONOS.15 — per-minute Sonos schedule application. Dormant (skipped:true) until SONOS_* env vars are set; still stamps.'
)
ON CONFLICT (name) DO UPDATE
  SET last_ok_at = now(),
      expected_interval_seconds = EXCLUDED.expected_interval_seconds,
      grace_seconds = EXCLUDED.grace_seconds,
      notes = EXCLUDED.notes;

-- 2. The old cron is gone; its heartbeat must go with it or it alerts forever.
DELETE FROM public.cron_heartbeats WHERE name = 'homey-reconcile';

-- 3. The device registry. Its only reader and writer were the routes and the
--    cron deleted in SONOS.14.
DROP TABLE IF EXISTS public.tapo_devices;
```

- [ ] **Step 2: Confirm the heartbeat column names match this table**

Run: `grep -rn "cron_heartbeats" supabase/migrations/471*.sql supabase/migrations/447*.sql 2>/dev/null | head`
Expected: the columns are `name`, `last_ok_at`, `expected_interval_seconds`, `grace_seconds`, `notes`. If the real table differs, adjust the INSERT to match — an INSERT naming a column that does not exist fails the whole migration.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/557_retire_homey_tapo.sql
git commit -m "SONOS.15 — mig 557: heartbeat swap + drop tapo_devices (apply post-deploy)"
```

---

## Ship sequence

Strict order. Steps 1 and 2 need Richard, not an implementer.

1. **Register the Control Integration** at `integration.sonos.com`. Redirect URI must be exactly `https://crm.repset.ie/api/sonos/callback` — HTTPS, publicly routable, exact match.
2. **Confirm the studio playlist is saved as a Sonos favourite.** `loadFavorite` only addresses favourites; a playlist that is not one cannot be selected.
3. **Apply migration 556** (tables only, safe any time) via the Supabase MCP against `iyvtbjjxdggiadzwwvdj`.
4. **Merge and deploy.** This removes the `homey-reconcile` cron and adds `sonos-reconcile`, which runs dormant — `getSonosConfig()` returns null until the env vars are set, so it stamps its heartbeat and exits.
5. **Apply migration 557** — heartbeat swap and table drop. Only now, never before step 4.
6. **Set the Vercel env vars**: `SONOS_CLIENT_ID`, `SONOS_CLIENT_SECRET`, `SONOS_REDIRECT_URI`. All three or none — half-set logs loudly every tick by design.
7. **Link the household**: `/automations/sonos` → Connect Sonos → consent.
8. **Configure and verify**: pick speakers, add the window, choose the favourite, enable. Then verify a real boundary — watch `sonos_schedules.last_applied` flip to `{action:'open'}` at the window start and `{action:'close'}` at the end.
9. **Run `get_advisors`** after both migrations.
10. **Only then unplug the Homey Pro.** Until step 8 is verified, it is still the thing starting the music.

## Verification gates

Every task ends green on its own tests. Before the PR:

```bash
npm test && npm run lint && npm run build
npm run check:rls-restrictive && npm run check:route-guards && npm run check:location-scoping && npm run check:secrets
```

## Deliberately out of scope

Class-linked music (the engine keeps `schedule_mode: 'class'`, the UI does not expose it), audio-clip announcements, per-player volume, group/ungroup control, and event subscriptions. None need a schema change to add later.
