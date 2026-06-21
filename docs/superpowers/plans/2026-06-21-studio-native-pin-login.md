# Studio Native PIN Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring token-pairing + PIN tap-in into the native CF Studio iOS app so a shared front-desk iPad is a true multi-user kiosk — each staffer taps in their PIN, gets a real Supabase session scoped to their access, and hands off to the next person via inactivity or "Return to PIN".

**Architecture:** Each PIN mints a *real* Supabase session server-side (so every existing direct-to-Supabase screen works unchanged). Pairing state (a device token in SecureStore) is independent of session state, so a paired device with no session shows the PIN pad, never the email login. Idle / "Return to PIN" fully signs out; the next PIN mints fresh and `onAuthStateChange` swaps the whole app. A per-user encrypted menu cache paints a returning staffer's options instantly.

**Tech Stack:** Next.js 16 route (`/api/auth/pin-login`) + `@supabase/supabase-js` admin `generateLink`/`verifyOtp` for passwordless session minting; Expo / React Native (`expo-secure-store`, expo-router) on the mobile side; Vitest for the pure/lib units.

**Spec:** [docs/STUDIO_NATIVE_PIN_LOGIN_DESIGN.md](../../STUDIO_NATIVE_PIN_LOGIN_DESIGN.md)

**Branch:** `studio-native-pin-login` (already created off `main`).

---

## File Structure

**Backend (web repo):**
- Create `src/lib/studio-session-mint.js` — `mintSupabaseSession({ admin, profileId })`: passwordless Supabase session mint (getUserById → generateLink → verifyOtp).
- Create `src/lib/studio-session-mint.test.js` — unit test (mock admin client + createClient).
- Modify `src/app/api/auth/pin-login/route.js` — add optional `mint_session` to the body; on success, when set, mint a session and add `access_token`/`refresh_token` to the response body. Web cookie path stays byte-identical when the flag is absent.
- Modify `src/app/api/auth/pin-login/route.test.js` — add `mint_session` coverage + a regression that the web path is unchanged.

**Mobile (`mobile/`):**
- Create `mobile/lib/studio-pin-lock-logic.js` — pure `shouldLockForIdle()` + `STUDIO_IDLE_MS` (vitest-testable, no native imports).
- Create `mobile/lib/studio-pin-lock-logic.test.js` — pure unit test.
- Create `mobile/lib/studio-device.js` — SecureStore pairing token + per-user menu cache (read/write/clear).
- Create `mobile/lib/studio-device.test.js` — unit test (mock `expo-secure-store`).
- Create `mobile/components/StudioPinPad.jsx` — full-screen PIN pad overlay; POSTs `pin-login` with `mint_session`.
- Create `mobile/lib/studio-pin.jsx` — `StudioPinProvider` + `useStudioPin()`: pairing state, idle timer, lock/unpair, renders the pad overlay.
- Modify `mobile/lib/auth-context.jsx` — write the menu cache on `/me` success; hydrate from cache on `onAuthStateChange` (paired devices only).
- Modify `mobile/app/_layout.jsx` — wrap the tree in `StudioPinProvider` (inside `AuthProvider`, around `BiometricLockProvider`).
- Modify `mobile/lib/biometric-lock.jsx` — make the biometric lock inert when the device is paired as a studio kiosk.
- Modify `mobile/app/(auth)/login.jsx` — add a "Set up as studio device" pairing mode.
- Modify `mobile/app/(tabs)/more.jsx` — when paired: "Return to PIN" + "Forget this studio device" rows.

**Ship:**
- Native EAS build + TestFlight (not OTA — new SecureStore surface + boot routing). Manual E2E checklist.

---

## Task 1: De-risk the session-mint mechanism (spike)

The whole feature hinges on minting a Supabase session for a profile without their password. `generateLink` + `verifyOtp` both exist in the pinned `@supabase/supabase-js ^2.45.0`, but the exact `type` pairing must be confirmed against the live project before building on it (per the "verify against the live system, not the docs" lesson). This task is **recommended but skippable** — if you can't get the service-role key into a local env, the unit tests (Task 2) still pass mocked and the real proof comes in TestFlight (Task 10). If you skip it, note that in the PR.

**Files:**
- Create (throwaway, do NOT commit): `scripts/spike-mint.mjs`

- [ ] **Step 1: Write the spike script**

```js
// scripts/spike-mint.mjs — throwaway. Run with the prod service-role key
// in env. Proves generateLink → verifyOtp yields a usable session.
// Requires: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
//           SUPABASE_SERVICE_ROLE_KEY, and a TEST_EMAIL of a real staff user.
import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const email = process.env.TEST_EMAIL

const admin = createClient(url, serviceKey)
const { data: link, error: e1 } = await admin.auth.admin.generateLink({ type: 'magiclink', email })
if (e1) { console.error('generateLink FAILED', e1); process.exit(1) }
console.log('hashed_token present:', !!link?.properties?.hashed_token)

const anon = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
const { data: v, error: e2 } = await anon.auth.verifyOtp({
  token_hash: link.properties.hashed_token,
  type: 'magiclink',
})
if (e2) { console.error('verifyOtp FAILED — try type: "email" instead', e2); process.exit(1) }
console.log('SESSION MINTED:', !!v?.session?.access_token, !!v?.session?.refresh_token)
```

- [ ] **Step 2: Run it against the project**

Run: `NEXT_PUBLIC_SUPABASE_URL=… NEXT_PUBLIC_SUPABASE_ANON_KEY=… SUPABASE_SERVICE_ROLE_KEY=… TEST_EMAIL=richard@richardivers.com node scripts/spike-mint.mjs`
Expected: `SESSION MINTED: true true`

If `verifyOtp FAILED`, change `type: 'magiclink'` → `type: 'email'` in BOTH the script and (later) the helper in Task 2, and re-run. Note which `type` worked — that's the one the helper must use.

- [ ] **Step 3: Delete the spike script (do not commit it)**

Run: `rm scripts/spike-mint.mjs`

No commit for this task.

---

## Task 2: Backend — `mintSupabaseSession` helper

**Files:**
- Create: `src/lib/studio-session-mint.js`
- Test: `src/lib/studio-session-mint.test.js`

- [ ] **Step 1: Write the failing test**

```js
// src/lib/studio-session-mint.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn() }))
const { createClient } = await import('@supabase/supabase-js')
const { mintSupabaseSession } = await import('./studio-session-mint.js')

function makeAdmin({ email = 'alice@un1t.ie', hashed_token = 'hash-123' } = {}) {
  return {
    auth: {
      admin: {
        getUserById: vi.fn(async () => ({ data: { user: { email } }, error: null })),
        generateLink: vi.fn(async () => ({ data: { properties: { hashed_token } }, error: null })),
      },
    },
  }
}

beforeEach(() => {
  createClient.mockReset()
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://supabase.test'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key'
})

describe('mintSupabaseSession', () => {
  it('returns access+refresh tokens on the happy path', async () => {
    const anon = { auth: { verifyOtp: vi.fn(async () => ({
      data: { session: { access_token: 'at-1', refresh_token: 'rt-1' } }, error: null,
    })) } }
    createClient.mockReturnValue(anon)
    const admin = makeAdmin()

    const out = await mintSupabaseSession({ admin, profileId: 'p-1' })
    expect(out).toEqual({ access_token: 'at-1', refresh_token: 'rt-1' })
    expect(admin.auth.admin.getUserById).toHaveBeenCalledWith('p-1')
    expect(admin.auth.admin.generateLink).toHaveBeenCalledWith({ type: 'magiclink', email: 'alice@un1t.ie' })
    expect(anon.auth.verifyOtp).toHaveBeenCalledWith({ token_hash: 'hash-123', type: 'magiclink' })
  })

  it('throws when the auth email cannot be resolved', async () => {
    const admin = makeAdmin()
    admin.auth.admin.getUserById = vi.fn(async () => ({ data: { user: null }, error: null }))
    await expect(mintSupabaseSession({ admin, profileId: 'p-1' })).rejects.toThrow(/auth email/)
  })

  it('throws when verifyOtp returns no session', async () => {
    const anon = { auth: { verifyOtp: vi.fn(async () => ({ data: { session: null }, error: null })) } }
    createClient.mockReturnValue(anon)
    await expect(mintSupabaseSession({ admin: makeAdmin(), profileId: 'p-1' })).rejects.toThrow(/no session/)
  })

  it('throws when profileId is missing', async () => {
    await expect(mintSupabaseSession({ admin: makeAdmin(), profileId: '' })).rejects.toThrow(/profileId/)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/studio-session-mint.test.js`
Expected: FAIL — `Failed to load ./studio-session-mint.js` (module doesn't exist yet).

- [ ] **Step 3: Write the helper**

```js
// src/lib/studio-session-mint.js
//
// Mint a real Supabase session for a profile WITHOUT a password — used
// by the studio-device PIN login on native. The iPad has no cookie to
// carry the studio_session envelope and reads Supabase directly, so each
// PIN must produce a genuine Supabase access+refresh pair the app can
// setSession() with.
//
// Mechanism (all server-side, NO email sent):
//   1. admin.getUserById  → the profile's canonical auth email
//   2. admin.generateLink → a magiclink hashed_token (generated, not emailed)
//   3. verifyOtp          → exchange the hash for a live session
//
// generateLink + verifyOtp are the documented passwordless-session path
// in @supabase/supabase-js (>=2.45). If the spike in Task 1 found that
// verifyOtp needs type:'email' rather than 'magiclink', change BOTH the
// generateLink type and the verifyOtp type to match what worked.

import { createClient } from '@supabase/supabase-js'

export async function mintSupabaseSession({ admin, profileId }) {
  if (!profileId) throw new Error('mintSupabaseSession: profileId required')

  // 1. Canonical auth email (robust to profiles.email drift).
  const { data: got, error: e1 } = await admin.auth.admin.getUserById(profileId)
  const email = got?.user?.email
  if (e1 || !email) throw new Error('mintSupabaseSession: could not resolve auth email')

  // 2. Magiclink hashed token — generated, NOT emailed.
  const { data: link, error: e2 } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email,
  })
  const tokenHash = link?.properties?.hashed_token
  if (e2 || !tokenHash) throw new Error('mintSupabaseSession: generateLink failed')

  // 3. Exchange for a session on a throwaway anon client (no persistence).
  const anon = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  )
  const { data: verified, error: e3 } = await anon.auth.verifyOtp({
    token_hash: tokenHash,
    type: 'magiclink',
  })
  const session = verified?.session
  if (e3 || !session?.access_token || !session?.refresh_token) {
    throw new Error('mintSupabaseSession: verifyOtp returned no session')
  }
  return { access_token: session.access_token, refresh_token: session.refresh_token }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/studio-session-mint.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/studio-session-mint.js src/lib/studio-session-mint.test.js
git commit -m "STUDIO-NATIVE-PIN.2 — passwordless Supabase session-mint helper"
```

---

## Task 3: Backend — extend `pin-login` with `mint_session`

**Files:**
- Modify: `src/app/api/auth/pin-login/route.js`
- Test: `src/app/api/auth/pin-login/route.test.js`

- [ ] **Step 1: Write the failing tests (append to the existing test file)**

Add this block at the end of `src/app/api/auth/pin-login/route.test.js`, before the final line. It mocks the mint helper so the route test stays DB-free:

```js
// --- mint_session (native) ---------------------------------------------
// The helper has its own unit test; here we mock it and lock the route
// contract: tokens appear in the body ONLY when mint_session is set, and
// the web cookie path is unchanged when it's absent.
vi.mock('@/lib/studio-session-mint', () => ({ mintSupabaseSession: vi.fn() }))
const { mintSupabaseSession } = await import('@/lib/studio-session-mint')

describe('pin-login — mint_session (native)', () => {
  beforeEach(() => {
    findDeviceByToken.mockResolvedValue(DEVICE)
    isTrustedIpForLocation.mockResolvedValue(true)
    getDeviceLockoutState.mockResolvedValue({ locked: false, recentFailures: 0 })
    findProfileByPin.mockResolvedValue(PROFILE)
    mintSupabaseSession.mockReset()
  })

  it('returns access+refresh tokens when mint_session is true', async () => {
    mintSupabaseSession.mockResolvedValue({ access_token: 'at-9', refresh_token: 'rt-9' })
    const res = await POST(buildRequest({
      body: { device_token: VALID_TOKEN, pin: VALID_PIN, mint_session: true },
    }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.access_token).toBe('at-9')
    expect(json.refresh_token).toBe('rt-9')
    expect(json.profile.id).toBe(PROFILE.id)
    expect(mintSupabaseSession).toHaveBeenCalledWith({ admin: expect.anything(), profileId: PROFILE.id })
    // Cookie still set (kept for parity; native ignores it).
    expect(res.headers.get('set-cookie') || '').toMatch(/^studio_session=/)
  })

  it('omits tokens entirely on the web path (no mint_session)', async () => {
    const res = await POST(buildRequest({ body: { device_token: VALID_TOKEN, pin: VALID_PIN } }))
    const json = await res.json()
    expect(json.access_token).toBeUndefined()
    expect(json.refresh_token).toBeUndefined()
    expect(mintSupabaseSession).not.toHaveBeenCalled()
  })

  it('500s with a clean message when the mint fails', async () => {
    mintSupabaseSession.mockRejectedValue(new Error('boom'))
    const res = await POST(buildRequest({
      body: { device_token: VALID_TOKEN, pin: VALID_PIN, mint_session: true },
    }))
    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json.success).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run src/app/api/auth/pin-login/route.test.js`
Expected: FAIL — the mint_session tests fail (tokens undefined; mint not called) because the route doesn't handle the flag yet. The existing gate tests still pass.

- [ ] **Step 3: Add `mint_session` to the body schema**

In `src/app/api/auth/pin-login/route.js`, replace the `Body` schema:

```js
const Body = z.object({
  device_token: z.string().min(16).max(256),
  pin: z.string().refine(isValidPinFormat, 'PIN must be exactly 4 digits'),
  // STUDIO-NATIVE-PIN — native callers set this to also receive a real
  // Supabase session (access+refresh) in the response body. Web omits it.
  mint_session: z.boolean().optional(),
})
```

And update the destructure a few lines down:

```js
  const { device_token, pin, mint_session } = validation.data
```

- [ ] **Step 4: Build the response as a payload object + optional mint**

In `src/app/api/auth/pin-login/route.js`, replace the success tail (from `const response = NextResponse.json({` through the final `return response`) with:

```js
  const payload = {
    success: true,
    profile: {
      id: matched.id,
      full_name: matched.full_name,
      home_screen_path: profile?.home_screen_path || '/dashboard',
    },
    device: {
      id: device.id,
      kind: device.device_kind,
      label: device.label,
      location_id: device.location_id,
    },
  }

  // STUDIO-NATIVE-PIN — native (iPad) callers can't use the studio_session
  // cookie (no cookie jar; they read Supabase directly), so when
  // mint_session is set we ALSO mint a real Supabase session and return
  // the tokens in the body. The web kiosk omits the flag and the response
  // is byte-identical to before (cookie only).
  if (mint_session) {
    try {
      const { mintSupabaseSession } = await import('@/lib/studio-session-mint')
      const tokens = await mintSupabaseSession({ admin: db, profileId: matched.id })
      payload.access_token = tokens.access_token
      payload.refresh_token = tokens.refresh_token
    } catch (err) {
      logWarn('pin-login', 'session mint failed', { err })
      return NextResponse.json(
        { success: false, error: 'Could not start session. Try again.' },
        { status: 500 },
      )
    }
  }

  const response = NextResponse.json(payload)
  response.headers.append(
    'Set-Cookie',
    `${STUDIO_COOKIE_NAME}=${cookie}; ${cookieAttributes()}`,
  )
  return response
```

- [ ] **Step 5: Run the route tests to verify all pass**

Run: `npx vitest run src/app/api/auth/pin-login/route.test.js`
Expected: PASS (all existing gate tests + 3 new mint_session tests).

- [ ] **Step 6: Verify the production build resolves the new import**

Run: `npm run build`
Expected: build completes (validates `@/lib/studio-session-mint` resolves — the CI "Test & lint" step does NOT catch import-resolution, only `next build` does).

- [ ] **Step 7: Commit**

```bash
git add 'src/app/api/auth/pin-login/route.js' 'src/app/api/auth/pin-login/route.test.js'
git commit -m "STUDIO-NATIVE-PIN.3 — pin-login mints a Supabase session for native callers"
```

---

## Task 4: Mobile — pure idle-lock logic

**Files:**
- Create: `mobile/lib/studio-pin-lock-logic.js`
- Test: `mobile/lib/studio-pin-lock-logic.test.js`

- [ ] **Step 1: Write the failing test**

```js
// mobile/lib/studio-pin-lock-logic.test.js
import { describe, it, expect } from 'vitest'
import { shouldLockForIdle, STUDIO_IDLE_MS } from './studio-pin-lock-logic'

describe('shouldLockForIdle', () => {
  it('is 5 minutes', () => {
    expect(STUDIO_IDLE_MS).toBe(5 * 60 * 1000)
  })
  it('false when never active', () => {
    expect(shouldLockForIdle(null, 1_000_000)).toBe(false)
  })
  it('false before the idle window elapses', () => {
    const t = 1_000_000
    expect(shouldLockForIdle(t, t + STUDIO_IDLE_MS - 1)).toBe(false)
  })
  it('true once the idle window elapses', () => {
    const t = 1_000_000
    expect(shouldLockForIdle(t, t + STUDIO_IDLE_MS)).toBe(true)
  })
  it('honours a custom window', () => {
    expect(shouldLockForIdle(0, 50, 100)).toBe(false)
    expect(shouldLockForIdle(0, 100, 100)).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run mobile/lib/studio-pin-lock-logic.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the pure logic**

```js
// mobile/lib/studio-pin-lock-logic.js
// Pure logic for the studio-device PIN idle lock. NO native imports —
// vitest runs this in Node. Mirrors biometric-lock-logic.js.

export const STUDIO_IDLE_MS = 5 * 60 * 1000 // 5 minutes — matches the web kiosk

// Lock the device back to the PIN pad once it's gone idle (no touches)
// for the timeout. lastActivityAt == null means "never active yet" →
// not idle (the app just opened / just unlocked).
export function shouldLockForIdle(lastActivityAt, now, idleMs = STUDIO_IDLE_MS) {
  if (lastActivityAt == null) return false
  return now - lastActivityAt >= idleMs
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run mobile/lib/studio-pin-lock-logic.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add mobile/lib/studio-pin-lock-logic.js mobile/lib/studio-pin-lock-logic.test.js
git commit -m "STUDIO-NATIVE-PIN.4 — pure idle-lock predicate for the studio PIN"
```

---

## Task 5: Mobile — pairing token + per-user menu cache

**Files:**
- Create: `mobile/lib/studio-device.js`
- Test: `mobile/lib/studio-device.test.js`

- [ ] **Step 1: Write the failing test**

```js
// mobile/lib/studio-device.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'

const store = new Map()
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (k) => (store.has(k) ? store.get(k) : null)),
  setItemAsync: vi.fn(async (k, v) => { store.set(k, v) }),
  deleteItemAsync: vi.fn(async (k) => { store.delete(k) }),
}))

const mod = await import('./studio-device.js')

beforeEach(() => { store.clear() })

describe('pairing', () => {
  it('round-trips a pairing token', async () => {
    expect(await mod.getPairing()).toBe(null)
    await mod.savePairing({ token: 'a'.repeat(20), label: 'Reception' })
    expect(await mod.getPairing()).toEqual({ token: 'a'.repeat(20), label: 'Reception' })
  })
  it('rejects a token shorter than 16 chars', async () => {
    await expect(mod.savePairing({ token: 'short' })).rejects.toThrow()
  })
  it('clearPairing wipes the token AND the menu cache', async () => {
    await mod.savePairing({ token: 'a'.repeat(20) })
    await mod.writeMenuCache('u1', { profile: { id: 'u1' } })
    await mod.clearPairing()
    expect(await mod.getPairing()).toBe(null)
    expect(await mod.readMenuCache('u1')).toBe(null)
  })
})

describe('menu cache', () => {
  it('round-trips a per-user blob and isolates users', async () => {
    await mod.writeMenuCache('u1', { profile: { id: 'u1', role: 'staff' }, locations: [], activeLocation: null })
    expect(await mod.readMenuCache('u1')).toEqual({ profile: { id: 'u1', role: 'staff' }, locations: [], activeLocation: null })
    expect(await mod.readMenuCache('u2')).toBe(null)
  })
  it('clearAllMenuCache wipes every cached user', async () => {
    await mod.writeMenuCache('u1', { profile: { id: 'u1' } })
    await mod.writeMenuCache('u2', { profile: { id: 'u2' } })
    await mod.clearAllMenuCache()
    expect(await mod.readMenuCache('u1')).toBe(null)
    expect(await mod.readMenuCache('u2')).toBe(null)
  })
  it('readMenuCache returns null for a falsy id', async () => {
    expect(await mod.readMenuCache('')).toBe(null)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run mobile/lib/studio-device.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

```js
// mobile/lib/studio-device.js
// Studio-device pairing + per-user menu cache, persisted in
// expo-secure-store (iOS Keychain). Two concerns, one small module:
//
//   1. Pairing — the device token + label that turn this iPad into a
//      shared studio kiosk. Presence of a token === "paired".
//   2. Menu cache — each returning staffer's {profile, locations,
//      activeLocation} blob, keyed by user id, so their options paint
//      instantly on tap-in (stale-while-revalidate). NEVER tokens,
//      NEVER customer data.
//
// All cache writes are best-effort: SecureStore has a ~2 KB per-value
// limit, so an unusually large menu blob (a master with many locations)
// may fail to persist — that just means no cache speed-up for that user,
// never a crash. The auth path must never throw because of the cache.

import * as SecureStore from 'expo-secure-store'

const PAIRING_KEY = 'studio_device_pairing'
const MENU_CACHE_PREFIX = 'studio_menu_cache.'
const MENU_INDEX_KEY = 'studio_menu_cache_index' // CSV of cached user ids

// --- Pairing -------------------------------------------------------------

export async function getPairing() {
  try {
    const raw = await SecureStore.getItemAsync(PAIRING_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export async function savePairing({ token, label }) {
  if (!token || token.length < 16) throw new Error('savePairing: token too short')
  await SecureStore.setItemAsync(PAIRING_KEY, JSON.stringify({ token, label: label || '' }))
}

export async function clearPairing() {
  await SecureStore.deleteItemAsync(PAIRING_KEY)
  await clearAllMenuCache()
}

// --- Menu cache ----------------------------------------------------------

export async function readMenuCache(userId) {
  if (!userId) return null
  try {
    const raw = await SecureStore.getItemAsync(`${MENU_CACHE_PREFIX}${userId}`)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export async function writeMenuCache(userId, data) {
  if (!userId || !data) return
  try {
    await SecureStore.setItemAsync(`${MENU_CACHE_PREFIX}${userId}`, JSON.stringify(data))
    await addToIndex(userId)
  } catch {
    // best-effort — never throw into the auth path (e.g. >2 KB blob).
  }
}

export async function clearAllMenuCache() {
  try {
    const idx = await SecureStore.getItemAsync(MENU_INDEX_KEY)
    const ids = idx ? idx.split(',').filter(Boolean) : []
    for (const id of ids) await SecureStore.deleteItemAsync(`${MENU_CACHE_PREFIX}${id}`)
    await SecureStore.deleteItemAsync(MENU_INDEX_KEY)
  } catch {
    // best-effort
  }
}

async function addToIndex(userId) {
  const idx = await SecureStore.getItemAsync(MENU_INDEX_KEY)
  const ids = new Set(idx ? idx.split(',').filter(Boolean) : [])
  ids.add(userId)
  await SecureStore.setItemAsync(MENU_INDEX_KEY, Array.from(ids).join(','))
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run mobile/lib/studio-device.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add mobile/lib/studio-device.js mobile/lib/studio-device.test.js
git commit -m "STUDIO-NATIVE-PIN.5 — SecureStore pairing token + per-user menu cache"
```

---

## Task 6: Mobile — menu-cache hydrate/write in auth-context

No unit test (auth-context is a React provider with native dynamic imports — the codebase doesn't unit-test it; `mobile/lib/studio-device.js` is covered in Task 5). Verification is `check:mobile-imports` + lint + the manual E2E in Task 10.

**Files:**
- Modify: `mobile/lib/auth-context.jsx`

- [ ] **Step 1: Add a cache-write to `refresh()` success**

In `mobile/lib/auth-context.jsx`, replace the body of the `refresh` useCallback's success branch. Find:

```js
    if (result.success && result.data) {
      setProfile(result.data.profile)
      setLocations(result.data.locations || [])
      setActiveLocation(result.data.activeLocation || null)
      setImpersonatingFrom(result.data.impersonatingFrom || null)
      setError(null)
    } else {
```

Replace with:

```js
    if (result.success && result.data) {
      setProfile(result.data.profile)
      setLocations(result.data.locations || [])
      setActiveLocation(result.data.activeLocation || null)
      setImpersonatingFrom(result.data.impersonatingFrom || null)
      setError(null)
      // STUDIO-NATIVE-PIN — on a paired studio device, cache this user's
      // menu so their next tap-in paints instantly. Best-effort; never
      // blocks or throws into the auth path.
      try {
        const { getPairing, writeMenuCache } = await import('./studio-device')
        if (await getPairing()) {
          writeMenuCache(result.data.profile.id, {
            profile: result.data.profile,
            locations: result.data.locations || [],
            activeLocation: result.data.activeLocation || null,
          })
        }
      } catch { /* best-effort cache */ }
    } else {
```

- [ ] **Step 2: Add a `hydrateFromCache` helper**

In `mobile/lib/auth-context.jsx`, immediately AFTER the `refresh` useCallback (before the bootstrap `useEffect`), add:

```js
  // STUDIO-NATIVE-PIN — paint a returning staffer's menu from the
  // encrypted per-user cache the instant their session lands, before the
  // network /me returns (stale-while-revalidate). Paired devices only.
  const hydrateFromCache = useCallback(async (userId) => {
    if (!userId) return
    try {
      const { getPairing, readMenuCache } = await import('./studio-device')
      if (!(await getPairing())) return
      const cached = await readMenuCache(userId)
      if (cached?.profile) {
        setProfile(cached.profile)
        setLocations(cached.locations || [])
        setActiveLocation(cached.activeLocation || null)
      }
    } catch { /* best-effort */ }
  }, [])
```

- [ ] **Step 3: Hydrate from cache in `onAuthStateChange` before revalidating**

In `mobile/lib/auth-context.jsx`, find the `onAuthStateChange` handler:

```js
    const { data: sub } = supabase.auth.onAuthStateChange(async (event, newSession) => {
      if (!mounted) return
      setSession(newSession)
      if (newSession) {
        refresh().catch(() => {})
      } else {
        setProfile(null)
        setLocations([])
        setActiveLocation(null)
      }
    })
```

Replace the `if (newSession)` branch so it hydrates first:

```js
    const { data: sub } = supabase.auth.onAuthStateChange(async (event, newSession) => {
      if (!mounted) return
      setSession(newSession)
      if (newSession) {
        // Paint from cache (instant), then revalidate over the network.
        hydrateFromCache(newSession.user?.id).finally(() => { refresh().catch(() => {}) })
      } else {
        setProfile(null)
        setLocations([])
        setActiveLocation(null)
      }
    })
```

- [ ] **Step 4: Add `hydrateFromCache` to the bootstrap effect's dependency array**

In `mobile/lib/auth-context.jsx`, find the bootstrap `useEffect` closing dependency line `}, [refresh])` (the one containing `supabase.auth.getSession()` and the `onAuthStateChange` subscription) and replace it with:

```js
  }, [refresh, hydrateFromCache])
```

- [ ] **Step 5: Verify imports resolve + lint clean**

Run: `npm run check:mobile-imports && npm run lint`
Expected: both pass (no unresolved imports; no lint errors).

- [ ] **Step 6: Commit**

```bash
git add mobile/lib/auth-context.jsx
git commit -m "STUDIO-NATIVE-PIN.6 — menu-cache hydrate/write in mobile auth-context"
```

---

## Task 7: Mobile — the PIN pad component

UI component; no unit test (consistent with the codebase's RN components). Verified via `check:mobile-imports` + lint + Task 10 E2E.

**Files:**
- Create: `mobile/components/StudioPinPad.jsx`

- [ ] **Step 1: Write the component**

```jsx
// mobile/components/StudioPinPad.jsx
// Full-screen opaque PIN pad shown over the app on a paired studio
// device when it's idle-locked or signed out. Enters 4 digits, auto-
// submits to /api/auth/pin-login with mint_session, and hands the minted
// tokens back to the provider. Uses a plain fetch (pin-login is a public
// route — it authenticates by device token + PIN, not a Bearer).
import { useState, useCallback } from 'react'
import { View, Text, Pressable, ActivityIndicator } from 'react-native'
import Constants from 'expo-constants'

const API_BASE = Constants.expoConfig?.extra?.apiBaseUrl
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del']

export default function StudioPinPad({ deviceToken, onSuccess }) {
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const submit = useCallback(async (value) => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${API_BASE}/api/auth/pin-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_token: deviceToken, pin: value, mint_session: true }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json?.access_token) {
        setPin('')
        setError(res.status === 429 ? 'Too many attempts. Wait a few minutes.' : 'Incorrect PIN.')
        setBusy(false)
        return
      }
      // Hand tokens to the provider; the overlay unmounts once the
      // session lands (provider clears `locked` + session becomes truthy).
      await onSuccess({ access_token: json.access_token, refresh_token: json.refresh_token })
    } catch {
      setPin('')
      setError('Network error. Try again.')
      setBusy(false)
    }
  }, [deviceToken, onSuccess])

  const press = useCallback((k) => {
    if (busy) return
    if (k === 'del') { setPin(p => p.slice(0, -1)); return }
    if (k === '') return
    setPin(p => {
      if (p.length >= 4) return p
      const next = p + k
      if (next.length === 4) submit(next)
      return next
    })
  }, [busy, submit])

  return (
    <View className="absolute inset-0 bg-un1t-bg items-center justify-center px-8">
      <Text className="text-2xl font-bold text-un1t-text mb-2">Enter your PIN</Text>
      <Text className="text-sm text-un1t-subtle mb-8">Tap in to use CF Studio</Text>

      <View className="flex-row gap-3 mb-8">
        {[0, 1, 2, 3].map(i => (
          <View key={i} className={`w-4 h-4 rounded-full ${i < pin.length ? 'bg-un1t-text' : 'bg-un1t-border'}`} />
        ))}
      </View>

      {error ? <Text className="text-red-500 text-sm mb-4">{error}</Text> : null}

      {busy ? (
        <ActivityIndicator color="#111827" />
      ) : (
        <View className="w-64 flex-row flex-wrap">
          {KEYS.map((k, i) => (
            <Pressable
              key={i}
              onPress={() => press(k)}
              disabled={k === ''}
              className="w-1/3 h-16 items-center justify-center active:opacity-50"
            >
              <Text className="text-2xl text-un1t-text">{k === 'del' ? '⌫' : k}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  )
}
```

- [ ] **Step 2: Verify imports resolve + lint clean**

Run: `npm run check:mobile-imports && npm run lint`
Expected: both pass.

- [ ] **Step 3: Commit**

```bash
git add mobile/components/StudioPinPad.jsx
git commit -m "STUDIO-NATIVE-PIN.7 — studio PIN pad overlay component"
```

---

## Task 8: Mobile — the StudioPinProvider + wiring + biometric gating

**Files:**
- Create: `mobile/lib/studio-pin.jsx`
- Modify: `mobile/app/_layout.jsx`
- Modify: `mobile/lib/biometric-lock.jsx`

- [ ] **Step 1: Write the provider**

```jsx
// mobile/lib/studio-pin.jsx
// Studio-device PIN lock provider. Sits inside AuthProvider, wraps the
// app, and renders the PIN-pad overlay on top when the device is paired
// AND (idle-locked OR signed out). Mirrors BiometricLockProvider's
// overlay pattern — the app underneath is never unmounted.
//
// On a paired device:
//   - touches reset an idle timer; 5 min idle → lock() (full sign-out)
//   - "Return to PIN" (More) → lock()
//   - a correct PIN mints a fresh Supabase session → the whole app swaps
//     to that staffer via auth-context's onAuthStateChange.
import { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react'
import { View } from 'react-native'
import { useAuth } from './auth-context'
import { getPairing, clearPairing } from './studio-device'
import { shouldLockForIdle, STUDIO_IDLE_MS } from './studio-pin-lock-logic'
import { supabase } from './supabase'
import StudioPinPad from '../components/StudioPinPad'

const StudioPinContext = createContext(null)

export function useStudioPin() {
  return useContext(StudioPinContext) || {
    paired: false, pairing: null,
    lock: () => {}, unpair: async () => {}, refreshPairing: async () => null,
  }
}

export function StudioPinProvider({ children }) {
  const { session, signOut } = useAuth()
  const [pairing, setPairing] = useState(null)
  const [pairingLoaded, setPairingLoaded] = useState(false)
  const [locked, setLocked] = useState(false)
  const lastActivity = useRef(Date.now())

  const refreshPairing = useCallback(async () => {
    const p = await getPairing()
    setPairing(p)
    setPairingLoaded(true)
    return p
  }, [])

  useEffect(() => { refreshPairing() }, [refreshPairing])

  const paired = !!pairing

  const recordActivity = useCallback(() => { lastActivity.current = Date.now() }, [])

  const lock = useCallback(async () => {
    setLocked(true)
    try { await signOut() } catch { /* best-effort: overlay shows regardless */ }
  }, [signOut])

  const onPinSuccess = useCallback(async ({ access_token, refresh_token }) => {
    await supabase.auth.setSession({ access_token, refresh_token })
    lastActivity.current = Date.now()
    setLocked(false)
  }, [])

  const unpair = useCallback(async () => {
    await clearPairing()
    await refreshPairing()
    setLocked(false)
    try { await signOut() } catch { /* best-effort */ }
  }, [refreshPairing, signOut])

  // Idle timer — only while paired with a live session. Checks every 20s.
  useEffect(() => {
    if (!paired || !session) return
    lastActivity.current = Date.now()
    const iv = setInterval(() => {
      if (shouldLockForIdle(lastActivity.current, Date.now(), STUDIO_IDLE_MS)) lock()
    }, 20_000)
    return () => clearInterval(iv)
  }, [paired, session, lock])

  // Avoid flashing the app/login before we know whether we're paired.
  if (!pairingLoaded) return null

  const showPad = paired && (locked || !session)

  return (
    <StudioPinContext.Provider value={{ paired, pairing, lock, unpair, refreshPairing }}>
      <View
        style={{ flex: 1 }}
        onStartShouldSetResponderCapture={() => { recordActivity(); return false }}
      >
        {children}
      </View>
      {showPad && pairing ? (
        <StudioPinPad deviceToken={pairing.token} onSuccess={onPinSuccess} />
      ) : null}
    </StudioPinContext.Provider>
  )
}
```

- [ ] **Step 2: Wire the provider into the root layout**

In `mobile/app/_layout.jsx`, add the import near the other lib imports (after the `BiometricLockProvider` import on line 28):

```js
import { StudioPinProvider } from '../lib/studio-pin'
```

Then wrap `BiometricLockProvider` with `StudioPinProvider`. Find:

```jsx
        <AuthProvider>
          <BiometricLockProvider>
```

Replace with:

```jsx
        <AuthProvider>
          <StudioPinProvider>
          <BiometricLockProvider>
```

And find the matching close:

```jsx
          </BiometricLockProvider>
        </AuthProvider>
```

Replace with:

```jsx
          </BiometricLockProvider>
          </StudioPinProvider>
        </AuthProvider>
```

- [ ] **Step 3: Make the biometric lock inert on a paired studio device**

In `mobile/lib/biometric-lock.jsx`, add the import after the `LockScreen` import (line 12):

```js
import { useStudioPin } from './studio-pin'
```

Inside `BiometricLockProvider`, read the paired flag right after `const { session } = useAuth()` (line 24):

```js
  const { paired } = useStudioPin()
```

Then gate the three lock effects so they no-op on a kiosk:

(a) Cold-start lock effect — change its guard. Find `if (!session) { booted.current = false; setLockState('unlocked'); return }` and replace with:

```js
    if (!session || paired) { booted.current = false; setLockState('unlocked'); return }
```
and add `paired` to that effect's dependency array: change `}, [session, promptUnlock])` to `}, [session, paired, promptUnlock])`.

(b) Re-lock-on-resume effect — change the inner condition `if (enabled && session && shouldRelock(...))` to:

```js
        if (enabled && session && !paired && shouldRelock(lastBg.current, Date.now(), RELOCK_GRACE_MS)) {
```
and add `paired` to its dependency array: change `}, [enabled, session, promptUnlock])` to `}, [enabled, session, paired, promptUnlock])`.

(c) Enable-prompt effect — change its early-return guard. Find `if (!session || !available || enabled || lockState !== 'unlocked') return` and replace with:

```js
    if (!session || paired || !available || enabled || lockState !== 'unlocked') return
```
and add `paired` to its dependency array: change `}, [session, available, enabled, lockState])` to `}, [session, available, paired, enabled, lockState])`.

- [ ] **Step 4: Verify imports resolve + lint clean**

Run: `npm run check:mobile-imports && npm run lint`
Expected: both pass. (`check:mobile-imports` confirms `studio-pin.jsx` ↔ `biometric-lock.jsx` ↔ `studio-device.js` ↔ `studio-pin-lock-logic.js` all resolve — this is the gate that catches the `undefined`-import class of bug.)

- [ ] **Step 5: Commit**

```bash
git add mobile/lib/studio-pin.jsx mobile/app/_layout.jsx mobile/lib/biometric-lock.jsx
git commit -m "STUDIO-NATIVE-PIN.8 — StudioPinProvider overlay + idle lock + biometric gating"
```

---

## Task 9: Mobile — pairing UI on login + More-screen rows

**Files:**
- Modify: `mobile/app/(auth)/login.jsx`
- Modify: `mobile/app/(tabs)/more.jsx`

- [ ] **Step 1: Add a "Set up as studio device" pairing mode to login**

In `mobile/app/(auth)/login.jsx`, add imports. Replace:

```js
import { useState } from 'react'
import { useRouter } from 'expo-router'
```

with:

```js
import { useState } from 'react'
import { useRouter } from 'expo-router'
import { savePairing } from '../../lib/studio-device'
import { useStudioPin } from '../../lib/studio-pin'
```

Inside the `Login` component, after `const router = useRouter()`, add pairing state + handler:

```js
  const { refreshPairing } = useStudioPin()
  const [mode, setMode] = useState('login') // 'login' | 'pair'
  const [pairToken, setPairToken] = useState('')
  const [pairLabel, setPairLabel] = useState('')
  const [pairError, setPairError] = useState(null)

  async function handlePair() {
    setPairError(null)
    const t = pairToken.trim()
    if (t.length < 16) {
      setPairError("That token doesn't look right — paste the full token from /admin/studio-devices.")
      return
    }
    try {
      await savePairing({ token: t, label: pairLabel.trim() })
      // Becoming paired makes StudioPinProvider show the PIN pad overlay.
      await refreshPairing()
    } catch {
      setPairError('Could not save the pairing token. Try again.')
    }
  }
```

Then add the pairing UI + a toggle link. Find the closing of the password card + the Sign in button + the footer text (lines ~86–105). Replace the footer `<Text>` block:

```jsx
          <Text className="text-xs text-un1t-subtle text-center mt-6">
            Forgot your password? Use the web app at{'\n'}crm.un1tdublin.com to reset it.
          </Text>
```

with a conditional that shows either the reset hint (login mode) or the pairing form (pair mode), plus the toggle:

```jsx
          {mode === 'pair' ? (
            <View className="mt-6">
              {pairError ? (
                <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 mb-3">
                  <Text className="text-red-500 text-sm">{pairError}</Text>
                </View>
              ) : null}
              <View className="bg-un1t-surface rounded-2xl border border-un1t-border overflow-hidden mb-3">
                <View className="px-4 py-3 border-b border-un1t-border">
                  <Text className="text-xs text-un1t-subtle mb-1">Pairing token</Text>
                  <TextInput
                    value={pairToken}
                    onChangeText={setPairToken}
                    placeholder="Paste the token from /admin/studio-devices"
                    placeholderTextColor="#94A3B8"
                    autoCapitalize="none"
                    autoCorrect={false}
                    className="text-base text-un1t-text"
                  />
                </View>
                <View className="px-4 py-3">
                  <Text className="text-xs text-un1t-subtle mb-1">Device label (optional)</Text>
                  <TextInput
                    value={pairLabel}
                    onChangeText={setPairLabel}
                    placeholder="e.g. Reception iPad"
                    placeholderTextColor="#94A3B8"
                    className="text-base text-un1t-text"
                  />
                </View>
              </View>
              <Pressable
                onPress={handlePair}
                disabled={!pairToken}
                className={`rounded-2xl py-4 items-center ${!pairToken ? 'bg-un1t-border' : 'bg-un1t-text'}`}
              >
                <Text className="text-un1t-bg font-semibold text-base">Pair this device</Text>
              </Pressable>
              <Pressable onPress={() => setMode('login')} className="py-3 items-center mt-1 active:opacity-70">
                <Text className="text-sm text-un1t-subtle">Back to sign in</Text>
              </Pressable>
            </View>
          ) : (
            <>
              <Text className="text-xs text-un1t-subtle text-center mt-6">
                Forgot your password? Use the web app at{'\n'}crm.un1tdublin.com to reset it.
              </Text>
              <Pressable onPress={() => setMode('pair')} className="py-3 items-center mt-4 active:opacity-70">
                <Text className="text-sm text-un1t-subtle underline">Set up as studio device</Text>
              </Pressable>
            </>
          )}
```

- [ ] **Step 2: Add the More-screen rows (Return to PIN + Forget device)**

In `mobile/app/(tabs)/more.jsx`, add the import near the `useBiometricLock` import (line 27):

```js
import { useStudioPin } from '../../lib/studio-pin'
```

Inside the `More` component, after `const biometric = useBiometricLock()` (line 70), add:

```js
  const { paired, lock: studioLock, unpair } = useStudioPin()
  function confirmUnpair() {
    Alert.alert(
      'Forget this studio device?',
      'This iPad will go back to normal email + password sign-in. Staff PINs will no longer work here until it is paired again.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Forget device', style: 'destructive', onPress: unpair },
      ],
    )
  }
```

Then render the two rows. Find the biometric toggle block (around lines 254–262, the `{biometric.available && (` block) and add the studio rows immediately BEFORE the `{/* Sign out */}` comment:

```jsx
      {paired && (
        <View className="mt-4">
          <Pressable
            onPress={studioLock}
            className="flex-row items-center justify-between bg-un1t-surface rounded-2xl border border-un1t-border px-4 py-3.5 active:opacity-80"
          >
            <Text className="text-base text-un1t-text">Return to PIN</Text>
            <Text className="text-sm text-un1t-subtle">Hand off to the next staffer</Text>
          </Pressable>
          <Pressable
            onPress={confirmUnpair}
            className="flex-row items-center justify-between bg-un1t-surface rounded-2xl border border-un1t-border px-4 py-3.5 mt-2 active:opacity-80"
          >
            <Text className="text-base text-red-500">Forget this studio device</Text>
          </Pressable>
        </View>
      )}
```

(`Alert` is already imported in `more.jsx` — it's used by `confirmSignOut`. If a lint error says otherwise, add `Alert` to the existing `react-native` import.)

- [ ] **Step 3: Verify imports resolve + lint clean**

Run: `npm run check:mobile-imports && npm run lint`
Expected: both pass.

- [ ] **Step 4: Run the full CI mirror**

Run: `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards`
Expected: all green. (No new permission key was added, so `check:mobile-parity` is unaffected; `pin-login` keeps its existing public-route guard posture, so `check:route-guards` is unaffected.)

- [ ] **Step 5: Commit**

```bash
git add 'mobile/app/(auth)/login.jsx' 'mobile/app/(tabs)/more.jsx'
git commit -m "STUDIO-NATIVE-PIN.9 — pairing UI on login + Return-to-PIN / Forget-device in More"
```

---

## Task 10: Native build + manual E2E

No code. This feature CANNOT ship via OTA (new SecureStore surface + boot routing changes), so it needs a native binary on a real iPad.

- [ ] **Step 1: Bump the native runtime + marketing version**

Run: `cd mobile && npm run version:minor && cd -`
(Edits `app.config.js`, commits, tags, pushes. New native surface → also bump `runtimeVersion` in `mobile/app.config.js` if it is a literal string rather than the sdkVersion policy — check and bump if needed so the OTA lane matches the new binary.)

- [ ] **Step 2: Build a preview/TestFlight binary**

Fastest device test path (no App Store wait): `cd mobile && eas build --profile preview --platform ios` (or `--profile production` for TestFlight). Install on the studio iPad.

- [ ] **Step 3: Manual E2E checklist (on the iPad)**

- [ ] Issue a token at `/admin/studio-devices`. In the app: Sign in screen → "Set up as studio device" → paste token → "Pair this device" → the PIN pad appears.
- [ ] Tap in PIN **A** (e.g. Richard/master) → lands in the app with A's tabs + permissions.
- [ ] Open More → "Return to PIN" → PIN pad returns (no email-login flash).
- [ ] Tap in PIN **B** (e.g. Becky) → app is now B, with B's (different) tabs + access.
- [ ] Leave the device untouched 5 min → it auto-returns to the PIN pad.
- [ ] A returning user's menu paints instantly on their 2nd tap-in (cache hit); the very first tap-in for a new user does a normal load.
- [ ] Confirm push notifications stop for the previous user after hand-off (no PII leak).
- [ ] More → "Forget this studio device" → confirm → reverts to email/password login; PINs no longer work until re-paired.
- [ ] Wrong PIN shows "Incorrect PIN"; 5 wrong PINs → "Too many attempts" (429 lockout intact).
- [ ] From OFF the studio wifi (cellular hotspot), a correct PIN is rejected (trusted-IP gate intact).

- [ ] **Step 4: Open the PR**

```bash
git push -u origin studio-native-pin-login
```
Then open a PR (base `main`) summarising the feature, citing the spec + this plan, and listing the manual E2E results. Flag the two items below for the reviewer.

---

## Notes for the reviewer / executor

- **Conscious spec deviation:** the spec's §2 "fold the /me payload into the pin-login response" optimization is intentionally NOT built. Folding it in would mean duplicating the `/api/mobile/me` locations+permissions loader (a documented drift hazard in this codebase) or refactoring `getCurrentUser` (highest-blast-radius function). The per-user menu cache (Task 5–6) delivers the same instant tap-in for the common case (returning staff) without either risk; `pin-login` returns tokens only. The spec has been reconciled to match.
- **Verify-early:** Task 1 confirms the `generateLink`/`verifyOtp` `type` against the live project. If it needed `type: 'email'`, ensure Task 2's helper uses the same.
- **No new permission key**, no migration, no new cron — this is auth-flow + mobile-shell only.

---

## Self-Review

**1. Spec coverage** — every spec section maps to a task:
- §1 Pairing → Task 5 (storage) + Task 9 Step 1 (UI).
- §2 PIN → real session → Task 2 (mint helper) + Task 3 (route) + Task 7/8 (app setSession). The "fold profile into response" sub-point is the documented conscious deviation (cache supersedes it) — reconciled in the spec.
- §3 Boot & routing → Task 8 (overlay above the tree; `pairingLoaded` guard prevents flash).
- §4 Menu cache → Task 5 (store) + Task 6 (hydrate/write).
- §5 Hand-off (idle/Return-to-PIN/switching) → Task 4 (idle predicate) + Task 8 (provider, lock=signOut, onPinSuccess swap) + Task 9 (Return to PIN row).
- §6 Active location → carried in the pin-login response → `/me` `activeLocation`; cached in Task 6. (No extra code — the device's location already drives the studio_session/`/me`.)
- §7 Unpair → Task 5 (`clearPairing`) + Task 9 (Forget-device row).
- §8 Security → Task 3 keeps all Phase-0 gates (IP/lockout); Task 5 cache holds no secrets; verified in Task 10 checklist.
- §Shipping → Task 10.

**2. Placeholder scan** — no TBD/TODO; every code step has complete code; every test step has real assertions; every run step has an exact command + expected result.

**3. Type/name consistency** — `savePairing`/`getPairing`/`clearPairing`/`readMenuCache`/`writeMenuCache`/`clearAllMenuCache` (Task 5) are used with those exact names in Tasks 6, 8, 9. `mintSupabaseSession({ admin, profileId })` (Task 2) is called identically in Task 3 and asserted in Task 3's test. `useStudioPin()` returns `{ paired, pairing, lock, unpair, refreshPairing }` (Task 8) and consumers in Task 9 destructure only those. `shouldLockForIdle`/`STUDIO_IDLE_MS` (Task 4) used in Task 8. `onSuccess({ access_token, refresh_token })` shape matches between StudioPinPad (Task 7) and `onPinSuccess` (Task 8). Response field names `access_token`/`refresh_token` match across route (Task 3), pad (Task 7), and provider (Task 8).
