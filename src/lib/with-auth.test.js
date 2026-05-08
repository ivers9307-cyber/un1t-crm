// withAuth wrapper tests. The contract every gated route depends
// on, so the assertions here are deliberately exhaustive — a bug in
// the wrapper would either silently 403 every user (no functional
// alarm) or silently let unauthenticated users through (security
// alarm). Pin both directions.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ __client: true })) }))

const { getCurrentUser } = await import('@/lib/auth')
const { withAuth, AUTH_ERRORS } = await import('./with-auth.js')

function user(overrides = {}) {
  return {
    id: 'u1',
    role: 'staff',
    activeLocation: { id: 'loc-1', features: {} },
    activeAssignment: { permissions: { schedule: true } },
    ...overrides,
  }
}

beforeEach(() => {
  getCurrentUser.mockReset()
})

describe('withAuth — option validation (fail fast at module load)', () => {
  it('throws on a typo in the permission key', () => {
    expect(() => withAuth({ permission: 'shedule' }, async () => null))
      .toThrow(/unknown permission key/i)
  })

  it('accepts a known permission key', () => {
    expect(() => withAuth({ permission: 'schedule' }, async () => null))
      .not.toThrow()
  })

  it('accepts permission: null for role-only gates', () => {
    // e.g. /admin routes that gate solely on role=master.
    expect(() => withAuth({ permission: null, roles: ['master'] }, async () => null))
      .not.toThrow()
  })

  it('throws when roles is an empty array', () => {
    expect(() => withAuth({ permission: 'schedule', roles: [] }, async () => null))
      .toThrow(/non-empty array/)
  })

  it('throws when handler is not a function', () => {
    expect(() => withAuth({ permission: 'schedule' }, 'oops'))
      .toThrow(/handler must be a function/)
  })
})

describe('withAuth — auth gate', () => {
  it('returns 401 for unauthenticated requests and never calls the handler', async () => {
    getCurrentUser.mockResolvedValue(null)
    const handler = vi.fn()
    const wrapped = withAuth({ permission: 'schedule' }, handler)
    const res = await wrapped(new Request('http://x/y'))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('withAuth — permission gate', () => {
  it('returns 403 with a humanised message when permission denied', async () => {
    getCurrentUser.mockResolvedValue(user({
      activeAssignment: { permissions: { studio_management: false } },
    }))
    const handler = vi.fn()
    const wrapped = withAuth({ permission: 'studio_management' }, handler)
    const res = await wrapped(new Request('http://x/y'))
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toMatch(/Studio management is not enabled/)
    expect(handler).not.toHaveBeenCalled()
  })

  it('passes through to the handler when permission granted', async () => {
    getCurrentUser.mockResolvedValue(user())
    const handler = vi.fn(async () => new Response('ok'))
    const wrapped = withAuth({ permission: 'schedule' }, handler)
    await wrapped(new Request('http://x/y'))
    expect(handler).toHaveBeenCalledTimes(1)
  })
})

describe('withAuth — role whitelist', () => {
  it('returns 403 when user role is not in the allowlist', async () => {
    getCurrentUser.mockResolvedValue(user({ role: 'staff' }))
    const handler = vi.fn()
    const wrapped = withAuth(
      { permission: 'schedule', roles: ['master', 'owner'] },
      handler
    )
    const res = await wrapped(new Request('http://x/y'))
    expect(res.status).toBe(403)
    expect(handler).not.toHaveBeenCalled()
  })

  it('passes when user role is in the allowlist', async () => {
    getCurrentUser.mockResolvedValue(user({ role: 'owner' }))
    const handler = vi.fn(async () => new Response('ok'))
    const wrapped = withAuth(
      { permission: 'schedule', roles: ['master', 'owner'] },
      handler
    )
    await wrapped(new Request('http://x/y'))
    expect(handler).toHaveBeenCalledTimes(1)
  })
})

describe('withAuth — location requirement', () => {
  it('returns 400 when location: true and the user has no active location', async () => {
    getCurrentUser.mockResolvedValue(user({ activeLocation: null }))
    const handler = vi.fn()
    const wrapped = withAuth({ permission: 'schedule' }, handler)
    const res = await wrapped(new Request('http://x/y'))
    expect(res.status).toBe(400)
    expect(handler).not.toHaveBeenCalled()
  })

  it('skips the location check when location: false', async () => {
    getCurrentUser.mockResolvedValue(user({ activeLocation: null, role: 'master' }))
    const handler = vi.fn(async () => new Response('ok'))
    // Use a master + null permission for cross-org admin shape.
    const wrapped = withAuth(
      { permission: null, roles: ['master'], location: false },
      handler
    )
    await wrapped(new Request('http://x/y'))
    expect(handler).toHaveBeenCalledTimes(1)
  })
})

describe('withAuth — handler context', () => {
  it('passes user, db, locationId, request, params into the handler', async () => {
    getCurrentUser.mockResolvedValue(user())
    let received
    const wrapped = withAuth({ permission: 'schedule' }, async (ctx) => {
      received = ctx
      return new Response('ok')
    })
    const req = new Request('http://x/y')
    await wrapped(req, { params: { id: 'abc' } })
    expect(received.user.id).toBe('u1')
    expect(received.db).toEqual({ __client: true })
    expect(received.locationId).toBe('loc-1')
    expect(received.request).toBe(req)
    expect(received.params).toEqual({ id: 'abc' })
  })

  it('locationId is null when location: false', async () => {
    getCurrentUser.mockResolvedValue(user({ role: 'master' }))
    let received
    const wrapped = withAuth(
      { permission: null, roles: ['master'], location: false },
      async (ctx) => { received = ctx; return new Response('ok') }
    )
    await wrapped(new Request('http://x/y'))
    expect(received.locationId).toBeNull()
  })
})

describe('AUTH_ERRORS shapes', () => {
  it('unauthorized matches the canonical 401 body', async () => {
    const r = AUTH_ERRORS.unauthorized()
    expect(r.status).toBe(401)
    expect(await r.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('forbidden humanises the key', async () => {
    const r = AUTH_ERRORS.forbidden('studio_management')
    expect(r.status).toBe(403)
    const body = await r.json()
    expect(body.error).toBe('Studio management is not enabled for your role at this location.')
  })
})
