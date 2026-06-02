// Header / cookie reader tests for the impersonation helpers. These
// pure-ish functions back the master "View as user" feature on both
// web (cookie path) and mobile (header path); a wrong UUID regex or
// the wrong combination order would silently break the feature on
// one platform without breaking the other, so pin both explicitly.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// next/headers must be mocked because the helpers call it
// synchronously. Each test reaches in and sets the underlying maps.
const cookieMap = new Map()
const headerMap = new Map()

vi.mock('next/headers', () => ({
  cookies: () => ({
    get: (name) => (cookieMap.has(name) ? { value: cookieMap.get(name) } : undefined),
    set: () => {},
  }),
  headers: () => ({
    get: (name) => headerMap.get(name.toLowerCase()) ?? null,
  }),
}))

const VALID = 'c6ab85ca-2e35-4aca-b65c-6407294bb1ed'

describe('readImpersonationCookie', () => {
  beforeEach(() => {
    cookieMap.clear()
    headerMap.clear()
  })

  it('returns null when no cookie is set', async () => {
    const { readImpersonationCookie } = await import('./impersonation.js')
    expect(await readImpersonationCookie()).toBe(null)
  })

  it('returns the value when it is a UUID', async () => {
    cookieMap.set('un1t_impersonate', VALID)
    const { readImpersonationCookie } = await import('./impersonation.js')
    expect(await readImpersonationCookie()).toBe(VALID)
  })

  it('rejects non-UUID values (defence-in-depth — the cookie is httpOnly, but trust nothing)', async () => {
    cookieMap.set('un1t_impersonate', 'not-a-uuid')
    const { readImpersonationCookie } = await import('./impersonation.js')
    expect(await readImpersonationCookie()).toBe(null)
  })
})

describe('readImpersonationHeader', () => {
  beforeEach(() => {
    cookieMap.clear()
    headerMap.clear()
  })

  it('returns null when no header is set', async () => {
    const { readImpersonationHeader } = await import('./impersonation.js')
    expect(await readImpersonationHeader()).toBe(null)
  })

  it('returns the value when x-impersonate-target is a UUID', async () => {
    headerMap.set('x-impersonate-target', VALID)
    const { readImpersonationHeader } = await import('./impersonation.js')
    expect(await readImpersonationHeader()).toBe(VALID)
  })

  it('rejects non-UUID header values', async () => {
    headerMap.set('x-impersonate-target', 'malicious; DROP TABLE')
    const { readImpersonationHeader } = await import('./impersonation.js')
    expect(await readImpersonationHeader()).toBe(null)
  })
})

describe('readImpersonationTarget (combined)', () => {
  beforeEach(() => {
    cookieMap.clear()
    headerMap.clear()
  })

  it('prefers the header over the cookie when both are set', async () => {
    const HEADER_TARGET = '11111111-1111-1111-1111-111111111111'
    const COOKIE_TARGET = '22222222-2222-2222-2222-222222222222'
    cookieMap.set('un1t_impersonate', COOKIE_TARGET)
    headerMap.set('x-impersonate-target', HEADER_TARGET)
    const { readImpersonationTarget } = await import('./impersonation.js')
    expect(await readImpersonationTarget()).toBe(HEADER_TARGET)
  })

  it('falls back to the cookie when the header is missing', async () => {
    cookieMap.set('un1t_impersonate', VALID)
    const { readImpersonationTarget } = await import('./impersonation.js')
    expect(await readImpersonationTarget()).toBe(VALID)
  })

  it('returns null when both are absent', async () => {
    const { readImpersonationTarget } = await import('./impersonation.js')
    expect(await readImpersonationTarget()).toBe(null)
  })
})

// Regression test for the ASI gotcha that broke "View as user" after
// the NEXT.16 async-cookies migration. Two adjacent
// `(await cookies()).set(...)` lines without an explicit semicolon
// got parsed as `set(...)(await cookies())` — calling the first
// .set's return value as a function. TypeError mid-handler, route
// returns 500, cookie never persists. Symptom: clicking "View as
// user" redirects you back to your own profile.
//
// The fix in production is to resolve the cookie store once and
// reuse the binding. This test asserts that startImpersonation
// calls `.set` for BOTH the impersonation cookie AND the
// active-location clear — under the bug, the second call never
// fires because the first throws.
describe('startImpersonation — ASI regression (cookie store reuse)', () => {
  it('writes both the impersonation cookie AND clears the active-location cookie', async () => {
    // Reset the vitest module cache so the doMocks below take effect
    // — earlier tests in this file already loaded impersonation.js
    // with the top-of-file `vi.mock('next/headers', ...)` shape, and
    // we need a fresh module graph here that includes the supabase
    // mock as well.
    vi.resetModules()

    const setSpy = vi.fn()
    vi.doMock('next/headers', () => ({
      cookies: async () => ({
        get: () => undefined,
        set: setSpy,
      }),
      headers: async () => ({ get: () => null }),
    }))

    // Mock the Supabase client — we need the impersonation insert + the
    // target lookup to succeed so we reach the cookie-set path.
    vi.doMock('./supabase.js', () => ({
      createServerClient: () => ({
        from: () => ({
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: { id: 'target-1', full_name: 'Target', role: 'staff', active: true },
                error: null,
              }),
            }),
          }),
          update: () => ({
            eq: () => ({
              is: async () => ({ data: null, error: null }),
            }),
          }),
          insert: async () => ({ error: null }),
        }),
      }),
    }))

    // Fresh import so the module-level mocks above take effect.
    const { startImpersonation } = await import('./impersonation.js')
    await startImpersonation({
      masterProfile: { id: 'master-1', role: 'master' },
      targetUserId: 'target-1',
      reason: 'debug',
    })

    // Both .set calls must fire — the impersonation cookie + the
    // active-location clear. Under the ASI bug, the second never
    // ran because the first one's return value got called-as-fn.
    const cookieNames = setSpy.mock.calls.map((c) => c[0])
    expect(cookieNames).toContain('un1t_impersonate')
    expect(cookieNames).toContain('un1t_active_location')
    expect(setSpy).toHaveBeenCalledTimes(2)
  })
})

// ── Stale-session reaper (close-stale-impersonations cron) ──────
// Rows only close on an explicit Stop / re-target, so a session that
// ends by tab-close / logout / cookie expiry dangles open forever. The
// reaper closes anything past the session max-age, stamping a TRUTHFUL
// upper-bound ended_at (started_at + max-age), not `now`.

const HOUR = 60 * 60 * 1000

describe('planStaleImpersonationCloses (pure)', () => {
  it('closes a row older than the max-age, stamping ended_at = started_at + max-age', async () => {
    const { planStaleImpersonationCloses } = await import('./impersonation.js')
    const now = Date.UTC(2026, 5, 2, 12, 0, 0)
    const startedAt = new Date(now - 3 * HOUR).toISOString() // 3h ago
    const plan = planStaleImpersonationCloses(
      [{ id: 'a', started_at: startedAt }], now, 7200, // 2h
    )
    expect(plan).toHaveLength(1)
    expect(plan[0].id).toBe('a')
    // ended_at is the upper bound (start + 2h), NOT now (3h after start).
    expect(plan[0].ended_at).toBe(new Date(now - 1 * HOUR).toISOString())
  })

  it('leaves a still-live row (younger than the max-age) alone', async () => {
    const { planStaleImpersonationCloses } = await import('./impersonation.js')
    const now = Date.UTC(2026, 5, 2, 12, 0, 0)
    const startedAt = new Date(now - 1 * HOUR).toISOString() // 1h ago, < 2h
    expect(planStaleImpersonationCloses([{ id: 'a', started_at: startedAt }], now, 7200)).toEqual([])
  })

  it('skips rows with a missing / unparseable started_at', async () => {
    const { planStaleImpersonationCloses } = await import('./impersonation.js')
    const now = Date.UTC(2026, 5, 2, 12, 0, 0)
    const plan = planStaleImpersonationCloses(
      [{ id: 'a', started_at: null }, { id: 'b', started_at: 'not-a-date' }], now, 7200,
    )
    expect(plan).toEqual([])
  })

  it('returns [] for empty / null input', async () => {
    const { planStaleImpersonationCloses } = await import('./impersonation.js')
    expect(planStaleImpersonationCloses([], Date.now(), 7200)).toEqual([])
    expect(planStaleImpersonationCloses(null, Date.now(), 7200)).toEqual([])
  })
})

describe('closeStaleImpersonations (IO)', () => {
  // Minimal fake of the supabase builder: a fresh chain per from(), the
  // select chain resolves to selectResult, the update chain records the
  // write and resolves { error: null }.
  function makeFakeDb({ selectResult, updates }) {
    return {
      from() {
        const b = { _mode: null, _id: null, _payload: null }
        b.select = () => { b._mode = 'select'; return b }
        b.update = (payload) => { b._mode = 'update'; b._payload = payload; return b }
        b.is = () => b
        b.lt = () => b
        b.eq = (_col, val) => { b._id = val; return b }
        b.then = (resolve) => {
          if (b._mode === 'select') return resolve(selectResult)
          updates.push({ id: b._id, payload: b._payload })
          return resolve({ error: null })
        }
        return b
      },
    }
  }

  it('closes every stale row with auto_closed=true and the upper-bound ended_at', async () => {
    const { closeStaleImpersonations } = await import('./impersonation.js')
    const now = Date.UTC(2026, 5, 2, 12, 0, 0)
    const startedAt = new Date(now - 5 * HOUR).toISOString()
    const updates = []
    const db = makeFakeDb({
      selectResult: { data: [{ id: 'row-1', started_at: startedAt }], error: null },
      updates,
    })
    const res = await closeStaleImpersonations(db, now, 7200)
    expect(res).toEqual({ ok: true, closed: 1, stale: 1 })
    expect(updates).toHaveLength(1)
    expect(updates[0].id).toBe('row-1')
    expect(updates[0].payload.auto_closed).toBe(true)
    expect(updates[0].payload.ended_at).toBe(new Date(now - 3 * HOUR).toISOString())
  })

  it('returns ok:false and writes nothing when the select errors', async () => {
    const { closeStaleImpersonations } = await import('./impersonation.js')
    const updates = []
    const db = makeFakeDb({ selectResult: { data: null, error: { message: 'boom' } }, updates })
    const res = await closeStaleImpersonations(db, Date.now(), 7200)
    expect(res.ok).toBe(false)
    expect(res.closed).toBe(0)
    expect(updates).toHaveLength(0)
  })
})
