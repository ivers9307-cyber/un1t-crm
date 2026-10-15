// WAHOMESTUDIO.1 (R5) — GET /api/whatsapp/templates?conversation_id=<id>: the
// picker inside a thread lists the templates of the studio that owns the
// thread's number (a same-organisation sibling's, for a number-less studio's
// thread). Authorised on the CONVERSATION's studio, cached rows only. Ids are
// synthetic.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(async () => ({ id: 'prof-1' })),
  assertLocationAccess: vi.fn(() => null),
  getUserLocationIds: vi.fn(() => ['a0000000-0000-4000-8000-000000000001']),
}))
vi.mock('@/lib/wa-template-access', () => ({ canManageWaTemplatesAt: vi.fn(() => true) }))
vi.mock('@/lib/whatsapp', () => ({ createTemplate: vi.fn(), getTemplates: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/whatsapp-config', () => ({ templateLocationIdFor: vi.fn() }))
vi.mock('@/lib/whatsapp-own-number', () => ({ ownNumberOrRefusal: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { GET } from './route.js'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { getTemplates as getMetaTemplates } from '@/lib/whatsapp'
import { createServerClient } from '@/lib/supabase'
import { templateLocationIdFor } from '@/lib/whatsapp-config'
import { ownNumberOrRefusal } from '@/lib/whatsapp-own-number'

const HATCH = 'a0000000-0000-4000-8000-000000000002'
const STILL = 'a0000000-0000-4000-8000-000000000001'
const CONV = 'b0000000-0000-4000-8000-000000000001'
const ROWS = [{ id: 'row-1', name: 'welcome', status: 'APPROVED', location_id: STILL }]

// A recording fake: every call on the templates table is kept so a test can
// assert the filters that reached it.
function makeDb({ conv = { id: CONV, location_id: HATCH }, convError = null, tplError = null } = {}) {
  const reads = { conversations: [], templates: [] }
  const db = {
    reads,
    from: vi.fn((table) => {
      const ops = []
      const b = {
        select: (cols) => { ops.push(['select', cols]); return b },
        eq: (col, val) => { ops.push(['eq', col, val]); return b },
        in: (col, val) => { ops.push(['in', col, val]); return b },
        order: (col, o) => { ops.push(['order', col, o]); return b },
        maybeSingle: async () => ({ data: conv, error: convError }),
        then: (res, rej) => Promise.resolve({ data: tplError ? null : ROWS, error: tplError }).then(res, rej),
      }
      if (table === 'whatsapp_conversations') reads.conversations.push({ ops })
      else if (table === 'whatsapp_templates') reads.templates.push({ ops })
      else throw new Error(`unexpected table: ${table}`)
      return b
    }),
  }
  return db
}

const req = (qs) => ({ url: `https://crm.test/api/whatsapp/templates?${qs}` })

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue({ id: 'prof-1' })
  assertLocationAccess.mockReturnValue(null)
})

describe('GET /api/whatsapp/templates?conversation_id= (WAHOMESTUDIO.1)', () => {
  it("serves the number owner's APPROVED templates for a conversation, authorised on the conversation's studio", async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    templateLocationIdFor.mockResolvedValue(STILL)

    const res = await GET(req(`conversation_id=${CONV}&status=APPROVED`))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(assertLocationAccess).toHaveBeenCalledWith(expect.anything(), HATCH)
    expect(templateLocationIdFor).toHaveBeenCalledTimes(1)
    expect(templateLocationIdFor).toHaveBeenCalledWith(HATCH, CONV)
    expect(body).toMatchObject({ success: true, templates: ROWS, template_location_id: STILL })
    const ops = db.reads.templates[0].ops
    expect(ops).toContainEqual(['eq', 'location_id', STILL])
    expect(ops).toContainEqual(['eq', 'status', 'APPROVED'])
    // Same row shape and order as the location mode.
    expect(ops).toContainEqual(['select', '*'])
    expect(ops).toContainEqual(['order', 'created_at', { ascending: false }])
  })

  it('without ?status= it lists every status', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    templateLocationIdFor.mockResolvedValue(HATCH)
    await GET(req(`conversation_id=${CONV}`))
    expect(db.reads.templates[0].ops.some(([op, col]) => op === 'eq' && col === 'status')).toBe(false)
  })

  it('an unknown conversation is a 404; no sync in this mode', async () => {
    createServerClient.mockReturnValue(makeDb({ conv: null }))
    const res = await GET(req('conversation_id=nope&sync=true'))
    expect(res.status).toBe(404)
    expect(ownNumberOrRefusal).not.toHaveBeenCalled()
    expect(getMetaTemplates).not.toHaveBeenCalled()
    expect(templateLocationIdFor).not.toHaveBeenCalled()
  })

  it('never syncs from Meta, even for a known conversation with ?sync=true', async () => {
    createServerClient.mockReturnValue(makeDb())
    templateLocationIdFor.mockResolvedValue(STILL)
    const res = await GET(req(`conversation_id=${CONV}&sync=true`))
    expect(res.status).toBe(200)
    expect(ownNumberOrRefusal).not.toHaveBeenCalled()
    expect(getMetaTemplates).not.toHaveBeenCalled()
    expect(await res.json()).not.toHaveProperty('sync_error')
  })

  it("a caller with no access to the conversation's studio is refused before any template read", async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    assertLocationAccess.mockReturnValue(new Response(JSON.stringify({ success: false, error: 'Forbidden' }), { status: 403 }))
    const res = await GET(req(`conversation_id=${CONV}`))
    expect(res.status).toBe(403)
    expect(db.reads.templates).toHaveLength(0)
    expect(templateLocationIdFor).not.toHaveBeenCalled()
  })

  it('a failed conversation read is a 500, not a 404', async () => {
    createServerClient.mockReturnValue(makeDb({ conv: null, convError: { message: 'boom' } }))
    const res = await GET(req(`conversation_id=${CONV}`))
    expect(res.status).toBe(500)
  })

  it('a failed template read is a 500', async () => {
    createServerClient.mockReturnValue(makeDb({ tplError: { message: 'read failed' } }))
    templateLocationIdFor.mockResolvedValue(STILL)
    const res = await GET(req(`conversation_id=${CONV}`))
    expect(res.status).toBe(500)
    expect((await res.json()).success).toBe(false)
  })
})
