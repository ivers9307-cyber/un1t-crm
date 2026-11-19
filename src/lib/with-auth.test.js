// withAuth wrapper tests. The contract every gated route depends
// on, so the assertions here are deliberately exhaustive — a bug in
// the wrapper would either silently 403 every user (no functional
// alarm) or silently let unauthenticated users through (security
// alarm). Pin both directions.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { z } from 'zod'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  // The real one re-resolves every field at the studio; this keeps the parts
  // the wrapper relies on: null for a studio the caller is not at, and the
  // role and assignment AT that studio.
  userAtLocation: vi.fn((u, locationId) => {
    const loc = (u.locations || []).find((l) => l.id === locationId)
    if (!loc) return null
    return { ...u, activeLocation: loc, role: u.rolesByLocation?.[locationId] || 'staff', activeAssignment: u.assignmentsByLocation?.[locationId] }
  }),
}))
vi.mock('@/lib/log', () => ({ logError: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ __client: true })) }))
vi.mock('@/lib/widget-auth', () => ({ getWidgetUser: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { logError } = await import('@/lib/log')
const { getWidgetUser } = await import('@/lib/widget-auth')
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
  getWidgetUser.mockReset()
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

describe('withAuth body validation (schema option)', () => {
  beforeEach(() => {
    getCurrentUser.mockResolvedValue({
      role: 'manager',
      activeLocation: { id: 'loc-1' },
      locations: [{ id: 'loc-1' }],
    })
  })

  const Schema = z.object({ name: z.string().min(1) })

  function jsonReq(body) {
    return new Request('http://localhost/api/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('passes parsed input to the handler when the body is valid', async () => {
    const handler = vi.fn(async ({ input }) =>
      new Response(JSON.stringify({ success: true, got: input }), { status: 200 })
    )
    const route = withAuth({ permission: 'schedule', schema: Schema }, handler)
    const res = await route(jsonReq({ name: 'Ada' }))
    expect(res.status).toBe(200)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0][0].input).toEqual({ name: 'Ada' })
  })

  it('returns 400 with issues and never calls the handler on invalid body', async () => {
    const handler = vi.fn()
    const route = withAuth({ permission: 'schedule', schema: Schema }, handler)
    const res = await route(jsonReq({ name: '' }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(Array.isArray(body.issues)).toBe(true)
    expect(handler).not.toHaveBeenCalled()
  })

  it('runs the auth gate BEFORE validation (401 wins over a bad body)', async () => {
    getCurrentUser.mockResolvedValue(null)
    const handler = vi.fn()
    const route = withAuth({ permission: 'schedule', schema: Schema }, handler)
    const res = await route(jsonReq({ name: '' }))
    expect(res.status).toBe(401)
    expect(handler).not.toHaveBeenCalled()
  })

  it('returns 400 when the body is not JSON', async () => {
    const route = withAuth({ permission: 'schedule', schema: Schema }, vi.fn())
    const res = await route(new Request('http://localhost/api/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    }))
    expect(res.status).toBe(400)
  })

  it('omits input when no schema is given (back-compat)', async () => {
    const handler = vi.fn(async (ctx) =>
      new Response(JSON.stringify({ success: true, hasInputKey: 'input' in ctx }), { status: 200 })
    )
    const route = withAuth({ permission: 'schedule' }, handler)
    const res = await route(new Request('http://localhost/api/x', { method: 'GET' }))
    const body = await res.json()
    expect(body.hasInputKey).toBe(false)
  })
})

describe('allowWidgetToken', () => {
  // NOTE: this file deliberately uses the REAL hasPermission — permission
  // outcomes are driven by the user object, not by a mock. `schedule` passes
  // because widgetUser() carries it; `studio_management` denies. Do not add a
  // permissions mock here; the existing tests depend on the real resolver.
  function widgetUser(overrides = {}) {
    return {
      id: 'u1',
      role: 'staff',
      authSource: 'widget',
      widgetTokenId: 'tok-1',
      activeLocation: { id: 'loc-1', features: {} },
      activeAssignment: { permissions: { schedule: true } },
      ...overrides,
    }
  }

  it('does not call getWidgetUser when the route did not opt in', async () => {
    getCurrentUser.mockResolvedValue(null)
    const handler = vi.fn()
    const wrapped = withAuth({ permission: 'schedule' }, handler)
    const res = await wrapped(new Request('https://x.test/api/thing'))
    expect(res.status).toBe(401)
    expect(getWidgetUser).not.toHaveBeenCalled()
    expect(handler).not.toHaveBeenCalled()
  })

  it('falls back to a widget token when the route opted in', async () => {
    getCurrentUser.mockResolvedValue(null)
    getWidgetUser.mockResolvedValue(widgetUser())
    const handler = vi.fn(async () => new Response('ok'))
    const wrapped = withAuth({ permission: 'schedule', allowWidgetToken: true }, handler)
    const res = await wrapped(new Request('https://x.test/api/thing'))
    expect(res.status).toBe(200)
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ locationId: 'loc-1' }))
  })

  it('prefers a real session over a widget token when both are present', async () => {
    getCurrentUser.mockResolvedValue(user({ activeLocation: { id: 'loc-9', features: {} } }))
    getWidgetUser.mockResolvedValue(widgetUser())
    const handler = vi.fn(async () => new Response('ok'))
    const wrapped = withAuth({ permission: 'schedule', allowWidgetToken: true }, handler)
    await wrapped(new Request('https://x.test/api/thing'))
    expect(getWidgetUser).not.toHaveBeenCalled()
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ locationId: 'loc-9' }))
  })

  it('still applies the permission gate to a widget user', async () => {
    getCurrentUser.mockResolvedValue(null)
    getWidgetUser.mockResolvedValue(widgetUser())
    const handler = vi.fn()
    const wrapped = withAuth({ permission: 'studio_management', allowWidgetToken: true }, handler)
    const res = await wrapped(new Request('https://x.test/api/thing'))
    expect(res.status).toBe(403)
    expect(handler).not.toHaveBeenCalled()
  })

  it('rejects a widget token on a route that requires no location', () => {
    // A widget token IS a location; a location-free route is by definition
    // estate-wide and must never accept one.
    expect(() => withAuth(
      { permission: null, roles: ['master'], location: false, allowWidgetToken: true },
      async () => new Response('ok')
    )).toThrow(/allowWidgetToken requires location/)
  })
})

// ROUTEWRAP.1 — the studio in the URL, judged there; and one error boundary.
describe('withAuth — location: param', () => {
  const A = 'loc-a'
  const B = 'loc-b'
  const staff = (over = {}) => ({
    id: 'u1', profileRole: 'staff', isMaster: false, role: 'manager',
    activeLocation: { id: A }, locations: [{ id: A }, { id: B }],
    rolesByLocation: { [A]: 'manager', [B]: 'staff' },
    assignmentsByLocation: { [A]: { permissions: { schedule: true } }, [B]: { permissions: { schedule: false } } },
    ...over,
  })
  const call = async (options, id, handler = async (ctx) => Response.json({ success: true, locationId: ctx.locationId, role: ctx.user.role })) => {
    const res = await withAuth(options, handler)(new Request(`https://crm.test/api/locations/${id}`), { params: Promise.resolve({ id }) })
    return { status: res.status, body: await res.json() }
  }

  it('a studio the caller is not at is a 404, before any role check', async () => {
    getCurrentUser.mockResolvedValue(staff())
    expect(await call({ permission: null, location: 'param', roles: ['owner'] }, 'loc-other')).toEqual({ status: 404, body: { success: false, error: 'Not found' } })
  })

  it('hands the handler the URL studio and the user AT that studio', async () => {
    getCurrentUser.mockResolvedValue(staff())
    expect((await call({ permission: null, location: 'param' }, B)).body).toEqual({ success: true, locationId: B, role: 'staff' })
  })

  it('judges roles at the URL studio, not the active one', async () => {
    getCurrentUser.mockResolvedValue(staff())
    expect((await call({ permission: null, location: 'param', roles: ['manager'] }, A)).status).toBe(200)
    expect((await call({ permission: null, location: 'param', roles: ['manager'] }, B)).status).toBe(403)
  })

  it('judges the permission at the URL studio', async () => {
    getCurrentUser.mockResolvedValue(staff())
    expect((await call({ permission: 'schedule', location: 'param' }, A)).status).toBe(200)
    expect((await call({ permission: 'schedule', location: 'param' }, B)).status).toBe(403)
  })

  it('a master passes a role gate at any studio they can see', async () => {
    getCurrentUser.mockResolvedValue(staff({ profileRole: 'master', isMaster: true, rolesByLocation: {} }))
    expect((await call({ permission: null, location: 'param', roles: ['owner'] }, B)).status).toBe(200)
  })

  it('uses the route\'s own refusal text when given', async () => {
    getCurrentUser.mockResolvedValue(staff())
    expect(await call({ permission: null, location: 'param', roles: ['owner'], forbiddenMessage: 'Only owners.' }, A))
      .toEqual({ status: 403, body: { success: false, error: 'Only owners.' } })
  })

  it('reads another param name when told to', async () => {
    getCurrentUser.mockResolvedValue(staff())
    const res = await withAuth({ permission: null, location: 'param', locationParam: 'locationId' }, async (ctx) => Response.json({ id: ctx.locationId }))(
      new Request('https://crm.test/x'), { params: Promise.resolve({ locationId: B }) })
    expect(await res.json()).toEqual({ id: B })
  })

  it('allow() refuses with 403 and receives the studio', async () => {
    getCurrentUser.mockResolvedValue(staff())
    const allow = vi.fn(() => false)
    expect((await call({ permission: null, location: 'param', allow }, B)).status).toBe(403)
    expect(allow).toHaveBeenCalledWith(expect.objectContaining({ role: 'staff' }), B)
  })

  it('master: true admits masters only', async () => {
    getCurrentUser.mockResolvedValue(staff())
    expect((await call({ permission: null, location: 'param', master: true }, A)).body).toEqual({ success: false, error: 'Master role required.' })
    getCurrentUser.mockResolvedValue(staff({ profileRole: 'master', isMaster: true }))
    expect((await call({ permission: null, location: 'param', master: true }, A)).status).toBe(200)
  })

  it('refuses an unknown location option when the file loads', () => {
    expect(() => withAuth({ permission: null, location: 'path' }, async () => null)).toThrow(/location must be/)
  })
})

describe('withAuth — one error boundary', () => {
  it('a throw is logged and answered with a fixed 500', async () => {
    getCurrentUser.mockResolvedValue(user())
    const err = new Error('relation "x" does not exist')
    const res = await withAuth({ permission: 'schedule' }, async () => { throw err })(new Request('https://crm.test/api/thing', { method: 'POST' }))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Something went wrong. Try again.' })
    expect(logError).toHaveBeenCalledWith('api', 'route failed', { route: '/api/thing', method: 'POST', err })
  })
})
