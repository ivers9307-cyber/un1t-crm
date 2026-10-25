// WAHOMESTUDIO.1 (R7) — staff move a thread between studios of ONE
// organisation. Fictional ids only (uuid-shaped: the body is validated with
// uuidLike).
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccessOr404: vi.fn(() => null),
  requireWhatsAppInboxAnywhere: vi.fn(() => null),
  requireWhatsAppInboxAt: vi.fn(() => null),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
import { GET, POST } from './route.js'
import { getCurrentUser, assertLocationAccessOr404, requireWhatsAppInboxAt } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { logError } from '@/lib/log'

const STILL = '00000000-0000-4000-8000-0000000000a1'
const HATCH = '00000000-0000-4000-8000-0000000000a2'
const OTHER = '00000000-0000-4000-8000-0000000000a3'
const CONV = { id: 'conv-1', location_id: STILL }
const LOCS = [
  { id: STILL, name: 'Stillorgan', organization_id: 'O1' },
  { id: HATCH, name: 'Hatch Street', organization_id: 'O1' },
  { id: OTHER, name: 'Elsewhere', organization_id: 'O2' },
]
// WAMOVENUMBER.1 — the studios with a WhatsApp number switched on: a
// location_whatsapp_numbers row embedding its number (the !inner read).
let LINKS
let rpc
let updates
let updateError
let failTable = null
function makeDb() {
  rpc = vi.fn(async () => ({ data: { conversation_id: 'conv-1', merged: false }, error: null }))
  updates = []
  return {
    rpc,
    from: (table) => {
      const filters = []
      const run = () => {
        if (table === failTable) return { data: null, error: { message: 'read failed' } }
        const src = table === 'whatsapp_conversations' ? [CONV] : table === 'locations' ? LOCS
          : table === 'location_whatsapp_numbers' ? LINKS : []
        return { data: src.filter((r) => filters.every((f) => f(r))), error: null }
      }
      const b = {
        select: () => b,
        update: (patch) => {
          const rec = { table, patch, eq: [] }
          updates.push(rec)
          const u = {
            eq: (c, v) => { rec.eq.push([c, v]); return u },
            then: (res, rej) => Promise.resolve({ data: null, error: updateError }).then(res, rej),
          }
          return u
        },
        eq: (c, v) => { filters.push((r) => (c.includes('.') ? r[c.split('.')[0]]?.[c.split('.')[1]] : r[c]) === v); return b },
        in: (c, vals) => { filters.push((r) => vals.includes(r[c])); return b },
        order: () => b,
        maybeSingle: async () => {
          const r = run()
          return r.error ? r : { data: r.data[0] ?? null, error: null }
        },
        then: (res, rej) => Promise.resolve(run()).then(res, rej),
      }
      return b
    },
  }
}
const params = { params: Promise.resolve({ id: 'conv-1' }) }
const post = (body) => new Request('http://x', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  vi.clearAllMocks()
  failTable = null
  updateError = null
  LINKS = [STILL, HATCH, OTHER].map((id) => ({ location_id: id, whatsapp_numbers: { id: 'n1', is_active: true } }))
  assertLocationAccessOr404.mockImplementation(() => null)
  getCurrentUser.mockResolvedValue({ id: 'u1', locations: [{ id: STILL }, { id: HATCH }, { id: OTHER }] })
  createServerClient.mockReturnValue(makeDb())
})

describe('GET move targets', () => {
  it('lists the caller’s other studios in the thread’s organisation only', async () => {
    const body = await (await GET(new Request('http://x'), params)).json()
    expect(body.data.targets).toEqual([{ id: HATCH, name: 'Hatch Street', whatsapp: true }])
  })
  it('WAMOVENUMBER.1: a studio with no active number switched on is listed with whatsapp: false', async () => {
    LINKS = [{ location_id: STILL, whatsapp_numbers: { id: 'n1', is_active: true } }, { location_id: HATCH, whatsapp_numbers: { id: 'n2', is_active: false } }]
    const body = await (await GET(new Request('http://x'), params)).json()
    expect(body.data.targets).toEqual([{ id: HATCH, name: 'Hatch Street', whatsapp: false }])
  })
  it('WAMOVENUMBER.1: a failed number read is a 500, never "no number"', async () => {
    failTable = 'location_whatsapp_numbers'
    const res = await GET(new Request('http://x'), params)
    expect(res.status).toBe(500)
    expect(logError).toHaveBeenCalled()
  })
  it('leaves out a studio where the caller has no WhatsApp inbox access', async () => {
    requireWhatsAppInboxAt.mockImplementation((u, loc) => (loc === HATCH ? new Response(null, { status: 403 }) : null))
    const body = await (await GET(new Request('http://x'), params)).json()
    expect(body.data.targets).toEqual([])
    requireWhatsAppInboxAt.mockImplementation(() => null)
  })
  it('a failed read is a 500, not an empty list', async () => {
    failTable = 'locations'
    const res = await GET(new Request('http://x'), params)
    expect(res.status).toBe(500)
  })
})

describe('POST move', () => {
  // WAMOVENUMBER.1 — since WAORGNUMBER.6 a studio with nothing switched on
  // cannot answer a thread (no sibling's number), so a move there is refused.
  it('a target with no WhatsApp number switched on → 409, the function never runs', async () => {
    LINKS = [{ location_id: STILL, whatsapp_numbers: { id: 'n1', is_active: true } }]
    const res = await POST(post({ location_id: HATCH }), params)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/no WhatsApp number switched on/)
    expect(rpc).not.toHaveBeenCalled()
    expect(updates).toEqual([])
  })
  it('a target whose only number is inactive is refused the same way', async () => {
    LINKS = [{ location_id: HATCH, whatsapp_numbers: { id: 'n2', is_active: false } }]
    expect((await POST(post({ location_id: HATCH }), params)).status).toBe(409)
    expect(rpc).not.toHaveBeenCalled()
  })
  it('a failed number read is a 500, the function never runs', async () => {
    failTable = 'location_whatsapp_numbers'
    const res = await POST(post({ location_id: HATCH }), params)
    expect(res.status).toBe(500)
    expect(rpc).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalled()
  })
  it('moves through the SQL function', async () => {
    const res = await POST(post({ location_id: HATCH }), params)
    expect(res.status).toBe(200)
    expect(rpc).toHaveBeenCalledWith('move_whatsapp_conversation', { p_conversation_id: 'conv-1', p_target_location_id: HATCH })
  })
  it('another organisation or the same studio → 400, the function never runs (Review Focus 5)', async () => {
    expect((await POST(post({ location_id: OTHER }), params)).status).toBe(400)
    expect((await POST(post({ location_id: STILL }), params)).status).toBe(400)
    expect(rpc).not.toHaveBeenCalled()
  })
  it('no access at the target → its 404, the function never runs', async () => {
    assertLocationAccessOr404.mockImplementation((u, loc) => (loc === HATCH ? new Response(null, { status: 404 }) : null))
    expect((await POST(post({ location_id: HATCH }), params)).status).toBe(404)
    expect(rpc).not.toHaveBeenCalled()
  })
  // F3 — the organisation check must not answer before the access check, or
  // a 400 vs 404 tells the caller whether a studio they cannot see is in the
  // thread's organisation.
  it('an inaccessible target in ANOTHER organisation → 404 (not 400), the function never runs', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', locations: [{ id: STILL }, { id: HATCH }] })
    assertLocationAccessOr404.mockImplementation((u, loc) => ((u.locations || []).some((l) => l.id === loc) ? null : new Response(null, { status: 404 })))
    const res = await POST(post({ location_id: OTHER }), params)
    expect(res.status).toBe(404)
    expect(rpc).not.toHaveBeenCalled()
  })
  it('an inaccessible target that does not exist → 404, the same answer', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', locations: [{ id: STILL }, { id: HATCH }] })
    assertLocationAccessOr404.mockImplementation((u, loc) => ((u.locations || []).some((l) => l.id === loc) ? null : new Response(null, { status: 404 })))
    const res = await POST(post({ location_id: '00000000-0000-4000-8000-0000000000ff' }), params)
    expect(res.status).toBe(404)
    expect(rpc).not.toHaveBeenCalled()
  })
  it('a failed read of the conversation is a 500, never a 404', async () => {
    failTable = 'whatsapp_conversations'
    expect((await POST(post({ location_id: HATCH }), params)).status).toBe(500)
    expect(rpc).not.toHaveBeenCalled()
  })
  it('a failed read of the target studio is a 500, the function never runs', async () => {
    const db = makeDb()
    const realFrom = db.from
    let n = 0
    db.from = (t) => { if (t === 'locations' && ++n === 2) failTable = 'locations'; return realFrom(t) }
    createServerClient.mockReturnValue(db)
    expect((await POST(post({ location_id: HATCH }), params)).status).toBe(500)
    expect(rpc).not.toHaveBeenCalled()
  })
  it('a function error is a 500 with no detail leaked', async () => {
    const db = makeDb()
    db.rpc = vi.fn(async () => ({ data: null, error: { message: 'boom' } }))
    createServerClient.mockReturnValue(db)
    const res = await POST(post({ location_id: HATCH }), params)
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('Could not move the conversation.')
    expect(logError).toHaveBeenCalled()
  })
  it.each([
    ['23505', 409, 'This customer already has a conversation at that studio that could not be merged automatically.'],
    ['P0002', 404, 'Not found'],
    ['22023', 400, 'A conversation can only move to a studio in the same organisation.'],
  ])('function error code %s maps to %i', async (code, status, message) => {
    const db = makeDb()
    db.rpc = vi.fn(async () => ({ data: null, error: { code, message: 'x' } }))
    createServerClient.mockReturnValue(db)
    const res = await POST(post({ location_id: HATCH }), params)
    expect(res.status).toBe(status)
    expect((await res.json()).error).toBe(message)
  })
  it('22023 same_studio from the function keeps the same-studio wording', async () => {
    const db = makeDb()
    db.rpc = vi.fn(async () => ({ data: null, error: { code: '22023', message: 'same_studio' } }))
    createServerClient.mockReturnValue(db)
    const res = await POST(post({ location_id: HATCH }), params)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('The conversation is already at this studio.')
  })
  it('reports merged=true', async () => {
    const db = makeDb()
    db.rpc = vi.fn(async () => ({ data: { conversation_id: 'conv-9', merged: true }, error: null }))
    createServerClient.mockReturnValue(db)
    const body = await (await POST(post({ location_id: HATCH }), params)).json()
    expect(body.data).toEqual({ conversation_id: 'conv-9', merged: true })
  })

  // WASTUDIOPICK.1 — a staff move settles the studio for good (spec R6).
  describe('records the decision', () => {
    it('writes studio_resolution { decided, staff, target } on the moved conversation', async () => {
      const res = await POST(post({ location_id: HATCH }), params)
      expect(res.status).toBe(200)
      expect(updates).toHaveLength(1)
      expect(updates[0].table).toBe('whatsapp_conversations')
      expect(updates[0].eq).toEqual([['id', 'conv-1']])
      expect(updates[0].patch.studio_resolution).toMatchObject({ status: 'decided', by: 'staff', location_id: HATCH })
      expect(Number.isNaN(Date.parse(updates[0].patch.studio_resolution.at))).toBe(false)
    })
    it('records on the RETURNED conversation id when the move merged into another thread', async () => {
      const db = makeDb()
      db.rpc = vi.fn(async () => ({ data: { conversation_id: 'conv-9', merged: true }, error: null }))
      createServerClient.mockReturnValue(db)
      await POST(post({ location_id: HATCH }), params)
      expect(updates[0].eq).toEqual([['id', 'conv-9']])
    })
    it('a failed write is logged and the move still answers 200', async () => {
      updateError = { message: 'write failed' }
      const res = await POST(post({ location_id: HATCH }), params)
      expect(res.status).toBe(200)
      expect((await res.json()).success).toBe(true)
      expect(logError).toHaveBeenCalledWith('wa-move', 'studio_resolution write failed', expect.objectContaining({ conversationId: 'conv-1', err: 'write failed' }))
    })
    it('a refused move records nothing', async () => {
      const db = makeDb()
      db.rpc = vi.fn(async () => ({ data: null, error: { code: '23505', message: 'x' } }))
      createServerClient.mockReturnValue(db)
      await POST(post({ location_id: HATCH }), params)
      expect(updates).toHaveLength(0)
    })
  })
})
