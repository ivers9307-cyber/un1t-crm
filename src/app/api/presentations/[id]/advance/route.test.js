// POST /api/presentations/[id]/advance through the real withAuth wrapper:
// `presentations` somewhere, then at the deck's studio (the full role sweep is
// tests/role-sweep/presentations-and-timer.test.js).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { POST } = await import('./route.js')

const DECK = 'de000000-0000-4000-8000-000000000001'
let db
let rpcAnswer
const advance = (index = 1) => POST(
  new Request(`http://localhost/api/presentations/${DECK}/advance`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ index }) }),
  { params: Promise.resolve({ id: DECK }) },
)
const decks = (on) => person({ [LOC_A]: { role: 'staff', permissions: { presentations: on } }, [LOC_B]: { role: 'staff', permissions: { presentations: true } } }, LOC_B)

beforeEach(() => {
  vi.clearAllMocks()
  rpcAnswer = { data: { current_index: 1, version: 4 }, error: null }
  db = createFakeDb({ tables: {
    presentations: [{ id: DECK, location_id: LOC_A, version: 3 }],
    presentation_slides: [
      { id: 'e1000000-0000-4000-8000-000000000001', presentation_id: DECK, location_id: LOC_A, position: 0 },
      { id: 'e1000000-0000-4000-8000-000000000002', presentation_id: DECK, location_id: LOC_A, position: 1 },
    ],
  } })
  db.rpc = vi.fn(() => ({ single: async () => rpcAnswer }))
  createServerClient.mockReturnValue(db)
})

describe('POST /api/presentations/[id]/advance', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await advance()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('403 "Not authorised for presentations" without it at the deck’s studio, nothing bumped', async () => {
    getCurrentUser.mockResolvedValue(decks(false))
    const res = await advance()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Not authorised for presentations' })
    expect(db.rpc).not.toHaveBeenCalled()
  })

  it('moves the deck on, the index clamped to its slides', async () => {
    getCurrentUser.mockResolvedValue(decks(true))
    const res = await advance(9)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, current_index: 1, version: 4 })
    expect(db.rpc).toHaveBeenCalledWith('bump_presentation_version', { p_presentation_id: DECK, p_current_index: 1 })
  })

  it('a failed bump is a 500 without the database text', async () => {
    getCurrentUser.mockResolvedValue(decks(true))
    rpcAnswer = { data: null, error: { message: 'secret detail' } }
    const res = await advance()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret detail')
  })
})
