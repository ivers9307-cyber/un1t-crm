// src/app/api/auth/account-state/route.test.js
// ACTIVEUSER.1 — "my Supabase session is valid, so why am I on /login?"
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(), createAuthClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn() }))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser, createAuthClient } = await import('@/lib/auth')
const { logError } = await import('@/lib/log')
const { fakeDb } = await import('@/lib/time-off.test-helpers')
const { GET } = await import('./route.js')

const ID = '10000000-0000-0000-0000-000000000004'

function arrange({ resolved = null, sessionUser = { id: ID }, profile = null, profileError = null, sessionThrows = false } = {}) {
  getCurrentUser.mockResolvedValue(resolved)
  createAuthClient.mockResolvedValue({
    auth: { getUser: async () => { if (sessionThrows) throw new Error('boom'); return { data: { user: sessionUser } } } },
  })
  const db = fakeDb((q) => {
    if (q.table === 'profiles' && q.action === 'select') return { data: profile, error: profileError }
    throw new Error(`unexpected ${q.action} on ${q.table}`)
  })
  createServerClient.mockReturnValue(db)
  return db
}

const stateOf = async () => {
  const res = await GET()
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.success).toBe(true)
  return body.data.state
}

beforeEach(() => vi.clearAllMocks())

describe('GET /api/auth/account-state', () => {
  it('active: getCurrentUser() resolves, and nothing else is read', async () => {
    const db = arrange({ resolved: { id: ID } })
    expect(await stateOf()).toBe('active')
    expect(createAuthClient).not.toHaveBeenCalled()
    expect(db.queries).toEqual([])
  })

  it('signed_out: no resolved user and no Supabase session either', async () => {
    const db = arrange({ sessionUser: null })
    expect(await stateOf()).toBe('signed_out')
    expect(db.queries).toEqual([])
  })

  it('deactivated: a VALID session whose own profile is active=false', async () => {
    const db = arrange({ profile: { id: ID, active: false, deleted_at: null } })
    expect(await stateOf()).toBe('deactivated')
    // Own row only: keyed on the SESSION's id, never on anything the caller sent.
    expect(db.queries).toHaveLength(1)
    expect(db.queries[0].eq).toEqual({ id: ID })
    expect(db.queries[0].columns).toBe('id, active, deleted_at')
  })

  it('a tombstone is NOT "deactivated": nobody can reactivate it, so the copy would be a lie', async () => {
    arrange({ profile: { id: ID, active: false, deleted_at: '2026-09-19T10:00:00Z' } })
    expect(await stateOf()).toBe('unknown')
  })

  it('unknown: a session with no staff profile at all (a member, a host)', async () => {
    arrange({ profile: null })
    expect(await stateOf()).toBe('unknown')
  })

  it('unknown, and logged, when the profile cannot be read — never a guess', async () => {
    arrange({ profileError: { message: 'db down' } })
    expect(await stateOf()).toBe('unknown')
    expect(logError).toHaveBeenCalled()
  })

  it('strictly active === false: a null `active` is not deactivated', async () => {
    arrange({ profile: { id: ID, active: null, deleted_at: null } })
    expect(await stateOf()).toBe('unknown')
  })

  it('every answer is Cache-Control: no-store — a cached "deactivated" would outlive a reactivation', async () => {
    for (const opts of [{ resolved: { id: ID } }, { sessionUser: null }, { profile: { id: ID, active: false, deleted_at: null } }, { profile: null }]) {
      arrange(opts)
      expect((await GET()).headers.get('cache-control')).toBe('no-store')
    }
  })

  it('a throwing session read is signed_out, not a 500', async () => {
    arrange({ sessionThrows: true })
    expect(await stateOf()).toBe('signed_out')
  })
})
