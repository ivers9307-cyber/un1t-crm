// WIDGET.1 — GET/POST /api/widget/tokens, the mint + list surface for the
// iOS widget's per-device credential.
//
// SESSION-ONLY. This suite pins that neither handler carries
// allowWidgetToken — a widget that could mint its own widget tokens would be
// a credential that renews itself straight past a revocation, which is the
// entire point a revocation exists (mig 607, src/lib/widget-token.js).
//
// withAuth itself is stubbed (same house style as widget/devices and the
// equipment routes) — this suite is about the ROUTE's own logic, not
// re-proving withAuth's gate. The schema-parsing half of the stub mirrors
// src/app/api/equipment/route.test.js so POST sees ctx.input exactly as the
// real wrapper would produce it.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  user: { id: 'prof-1', role: 'staff', profileRole: 'staff', activeLocation: { id: 'loc-1' } },
  locationId: 'loc-1',
  db: null,
}))

vi.mock('@/lib/with-auth', () => ({
  withAuth: (opts, handler) => Object.assign(
    async (request, ctx) => {
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
        db: h.db,
        locationId: h.locationId,
        request,
        input,
        params: ctx?.params ? await ctx.params : undefined,
      })
    },
    { _opts: opts }
  ),
}))

vi.mock('@/lib/permissions', () => ({ hasPermission: vi.fn() }))

import { GET, POST } from './route.js'
import { hasPermission } from '@/lib/permissions'

function getReq(qs = '') {
  return new Request(`https://x.test/api/widget/tokens${qs}`, { method: 'GET' })
}

function postReq(body) {
  return new Request('https://x.test/api/widget/tokens', {
    method: 'POST',
    body: JSON.stringify(body ?? {}),
  })
}

// A row shaped like the real widget_tokens table (token_hash included) so a
// route that forwarded raw rows instead of mapping them would leak the hash
// straight into the assertion below.
const LIVE_ROW = {
  id: 'tok-1',
  profile_id: 'prof-1',
  location_id: 'loc-1',
  token_hash: 'a'.repeat(64),
  device_label: 'Richard iPhone',
  created_at: '2026-09-01T00:00:00.000Z',
  last_used_at: null,
  revoked_at: null,
}

function mockDb({ listRows = [], listError = null, insertedId = 'tok-new', insertError = null } = {}) {
  const calls = { eq: [], insert: null }
  const db = {
    from: (table) => {
      if (table !== 'widget_tokens') throw new Error(`unexpected table ${table}`)
      return {
        select: () => ({
          eq: (col, val) => {
            calls.eq.push([col, val])
            return {
              is: () => ({
                order: () => Promise.resolve({ data: listRows, error: listError }),
              }),
            }
          },
        }),
        insert: (row) => {
          calls.insert = row
          return {
            select: () => ({
              single: () => Promise.resolve({
                data: insertError ? null : { id: insertedId },
                error: insertError,
              }),
            }),
          }
        },
      }
    },
  }
  return { db, calls }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.user = { id: 'prof-1', role: 'staff', profileRole: 'staff', activeLocation: { id: 'loc-1' } }
  h.locationId = 'loc-1'
  hasPermission.mockReturnValue(false)
})

describe('session-only: no allowWidgetToken', () => {
  it('GET does not carry allowWidgetToken', () => {
    expect(GET._opts.allowWidgetToken).toBeFalsy()
  })

  it('POST does not carry allowWidgetToken', () => {
    expect(POST._opts.allowWidgetToken).toBeFalsy()
  })
})

describe('POST /api/widget/tokens (mint)', () => {
  it('returns a plaintext token matching /^rwt_/ and the new row id', async () => {
    const { db } = mockDb({ insertedId: 'tok-abc' })
    h.db = db

    const res = await POST(postReq({ device_label: 'Richard iPhone' }))
    const body = await res.json()

    expect(body.success).toBe(true)
    expect(body.data.id).toBe('tok-abc')
    expect(body.data.token).toMatch(/^rwt_/)
  })

  it('stores only a 64-hex token_hash — the plaintext never appears in the inserted row', async () => {
    const { db, calls } = mockDb()
    h.db = db

    const res = await POST(postReq({ device_label: 'Richard iPhone' }))
    const body = await res.json()

    expect(calls.insert.token_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(calls.insert)).not.toContain(body.data.token)
  })

  it('scopes the inserted row to the caller and the active location', async () => {
    const { db, calls } = mockDb()
    h.db = db
    h.user = { id: 'prof-9', role: 'manager', profileRole: 'manager', activeLocation: { id: 'loc-9' } }
    h.locationId = 'loc-9'

    await POST(postReq({ device_label: 'Manager phone' }))

    expect(calls.insert.profile_id).toBe('prof-9')
    expect(calls.insert.location_id).toBe('loc-9')
  })
})

describe('GET /api/widget/tokens (list)', () => {
  it('lists the caller\'s own live tokens and never returns token_hash', async () => {
    const { db } = mockDb({ listRows: [LIVE_ROW] })
    h.db = db

    const res = await GET(getReq())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.tokens).toHaveLength(1)
    expect(body.data.tokens[0]).toMatchObject({
      id: 'tok-1',
      device_label: 'Richard iPhone',
    })
    expect(JSON.stringify(body)).not.toContain('token_hash')
  })

  it('defaults to the caller\'s own profile_id when none is given', async () => {
    const { db, calls } = mockDb({ listRows: [] })
    h.db = db

    await GET(getReq())

    expect(calls.eq).toContainEqual(['profile_id', 'prof-1'])
  })

  it("another profile's list requires staff_management — without it, returns an empty list, not an error", async () => {
    const { db, calls } = mockDb({ listRows: [LIVE_ROW] })
    h.db = db
    hasPermission.mockReturnValue(false)

    const res = await GET(getReq('?profile_id=someone-else'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.data.tokens).toEqual([])
    // The permission-denied path must short-circuit before ever querying —
    // no accidental fall-through that fetches then discards.
    expect(calls.eq).toHaveLength(0)
  })

  it("another profile's list is returned when the caller holds staff_management", async () => {
    const { db, calls } = mockDb({ listRows: [LIVE_ROW] })
    h.db = db
    hasPermission.mockReturnValue(true)

    const res = await GET(getReq('?profile_id=someone-else'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.tokens).toHaveLength(1)
    expect(calls.eq).toContainEqual(['profile_id', 'someone-else'])
    expect(hasPermission).toHaveBeenCalledWith(h.user, 'staff_management')
  })
})
