// GET/POST /api/presentations and GET/DELETE /api/presentations/[id] through
// the real withAuth wrapper (the full role sweep is
// tests/role-sweep/presentations-and-timer.test.js).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const decks = await import('./route.js')
const deck = await import('./[id]/route.js')

const DECK = 'de000000-0000-4000-8000-000000000001'
let db
const json = (method, body) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const list = (loc = LOC_A) => decks.GET(new Request(`http://localhost/api/presentations?location_id=${loc}`))
const create = (body = { location_id: LOC_A, title: 'Deck' }) => decks.POST(new Request('http://localhost/api/presentations', json('POST', body)))
const one = (method) => deck[method](new Request(`http://localhost/api/presentations/${DECK}`, { method }), { params: Promise.resolve({ id: DECK }) })
const caller = (on) => person({ [LOC_A]: { role: 'staff', permissions: { presentations: on } }, [LOC_B]: { role: 'staff', permissions: { presentations: true } } }, LOC_B)
const NO = { success: false, error: 'Not authorised for presentations' }

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: {
    presentations: [{ id: DECK, location_id: LOC_A, title: 'Deck', view_token: 'tok', current_index: 0, version: 1 }],
    presentation_slides: [],
  } })
  db.storage = { from: vi.fn(() => ({ remove: vi.fn(async () => ({})) })) }
  createServerClient.mockReturnValue(db)
})

describe('presentations routes', () => {
  it.each([['GET list', () => list()], ['POST create', () => create()], ['GET deck', () => one('GET')], ['DELETE deck', () => one('DELETE')]])('%s: 401 signed out', async (_l, call) => {
    getCurrentUser.mockResolvedValue(null)
    const res = await call()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it("403 without presentations at the deck's studio; nothing deleted", async () => {
    getCurrentUser.mockResolvedValue(caller(false))
    for (const res of [await list(), await create(), await one('GET'), await one('DELETE')]) {
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual(NO)
    }
    expect(db.tables.presentations).toHaveLength(1)
  })

  it("404 for another studio's deck", async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_B]: { role: 'owner', permissions: { presentations: true } } }, LOC_B))
    expect((await one('GET')).status).toBe(404)
    expect((await one('DELETE')).status).toBe(404)
    expect(db.tables.presentations).toHaveLength(1)
  })

  it('lists, reads and deletes with the grant at the studio', async () => {
    getCurrentUser.mockResolvedValue(caller(true))
    expect((await (await list()).json()).presentations.map((p) => p.id)).toEqual([DECK])
    expect((await (await one('GET')).json()).presentation.id).toBe(DECK)
    expect((await one('DELETE')).status).toBe(200)
    expect(db.tables.presentations).toHaveLength(0)
  })

  it('database failures are 500s without the database text', async () => {
    getCurrentUser.mockResolvedValue(caller(true))
    db.errors.presentations = { select: { message: 'secret detail' }, insert: { message: 'secret detail' }, delete: { message: 'secret detail' } }
    for (const res of [await list(), await create()]) {
      expect(res.status).toBe(500)
      expect(JSON.stringify(await res.json())).not.toContain('secret detail')
    }
  })
})
