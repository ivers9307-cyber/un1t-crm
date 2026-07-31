// EQUIP-MAINT.1 — route tests for equipment types.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  user: { id: 'prof-owner', full_name: 'Olive Owner', email: 'olive@un1t.ie', role: 'owner' },
  locationId: 'loc-1',
}))

// withAuth mock: mirrors the real wrapper by parsing the body through
// the schema option and exposing it as ctx.input.
vi.mock('@/lib/with-auth', () => ({
  withAuth: (opts, handler) => async (request, ctx) => {
    let input
    if (opts?.schema) {
      const parsed = opts.schema.safeParse(await request.json())
      if (!parsed.success) {
        return {
          status: 400,
          json: async () => ({ success: false, error: 'Invalid body.', issues: parsed.error.issues }),
        }
      }
      input = parsed.data
    }
    return handler({
      user: h.user,
      db: {},
      locationId: h.locationId,
      request,
      input,
      params: ctx?.params ? await ctx.params : undefined,
    })
  },
}))
vi.mock('@/lib/equipment-db', () => ({
  listTypes: vi.fn(),
  insertType: vi.fn(),
}))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(async () => ({ logged: true })) }))

import { GET, POST } from './route.js'
import { listTypes, insertType } from '@/lib/equipment-db'

function req(body, url = 'http://localhost/api/equipment/types') {
  return { json: async () => body, url, headers: { get: () => null } }
}

const VALID = {
  name: 'Treadmill',
  intervalWeeks: 4,
  items: [
    { id: 'a', label: 'Check belt wear' },
    { id: 'b', label: 'Emergency stop works' },
  ],
}

beforeEach(() => {
  vi.clearAllMocks()
  listTypes.mockResolvedValue([])
  insertType.mockResolvedValue({ id: 'type-1', name: 'Treadmill', interval_weeks: 4, items: [] })
})

describe('POST /api/equipment/types', () => {
  it('renumbers item order from array position, ignoring client-sent order', async () => {
    await POST(req({ ...VALID, items: [
      { id: 'a', label: 'Check belt wear', order: 9 },
      { id: 'b', label: 'Emergency stop works', order: 4 },
    ] }))
    expect(insertType).toHaveBeenCalledWith({}, expect.objectContaining({
      items: [
        { id: 'a', label: 'Check belt wear', order: 0 },
        { id: 'b', label: 'Emergency stop works', order: 1 },
      ],
    }))
  })

  it('rejects duplicate item ids with 400', async () => {
    const res = await POST(req({ ...VALID, items: [
      { id: 'same', label: 'one' },
      { id: 'same', label: 'two' },
    ] }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/duplicate/i)
    expect(insertType).not.toHaveBeenCalled()
  })

  it('rejects an empty checklist with 400', async () => {
    const res = await POST(req({ ...VALID, items: [] }))
    expect(res.status).toBe(400)
    expect(insertType).not.toHaveBeenCalled()
  })

  it('maps a unique-name violation to 409, not a 500', async () => {
    insertType.mockRejectedValue({ code: '23505' })
    const res = await POST(req(VALID))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/already exists/i)
  })

  it('rethrows a non-unique DB error rather than swallowing it', async () => {
    insertType.mockRejectedValue({ code: '42703', message: 'column does not exist' })
    await expect(POST(req(VALID))).rejects.toMatchObject({ code: '42703' })
  })
})

describe('GET /api/equipment/types', () => {
  it('lists enabled types only by default', async () => {
    await GET(req(null))
    expect(listTypes).toHaveBeenCalledWith({}, 'loc-1', { includeDisabled: false })
  })

  it('includes disabled types when asked', async () => {
    await GET(req(null, 'http://localhost/api/equipment/types?includeDisabled=1'))
    expect(listTypes).toHaveBeenCalledWith({}, 'loc-1', { includeDisabled: true })
  })
})
