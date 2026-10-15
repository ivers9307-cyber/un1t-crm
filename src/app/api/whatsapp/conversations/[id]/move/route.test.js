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
let rpc
let failTable = null
function makeDb() {
  rpc = vi.fn(async () => ({ data: { conversation_id: 'conv-1', merged: false }, error: null }))
  return {
    rpc,
    from: (table) => {
      const filters = []
      const run = () => {
        if (table === failTable) return { data: null, error: { message: 'read failed' } }
        const src = table === 'whatsapp_conversations' ? [CONV] : table === 'locations' ? LOCS : []
        return { data: src.filter((r) => filters.every((f) => f(r))), error: null }
      }
      const b = {
        select: () => b,
        eq: (c, v) => { filters.push((r) => r[c] === v); return b },
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
  assertLocationAccessOr404.mockImplementation(() => null)
  getCurrentUser.mockResolvedValue({ id: 'u1', locations: [{ id: STILL }, { id: HATCH }, { id: OTHER }] })
  createServerClient.mockReturnValue(makeDb())
})

describe('GET move targets', () => {
  it('lists the caller’s other studios in the thread’s organisation only', async () => {
    const body = await (await GET(new Request('http://x'), params)).json()
    expect(body.data.targets).toEqual([{ id: HATCH, name: 'Hatch Street' }])
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
})
