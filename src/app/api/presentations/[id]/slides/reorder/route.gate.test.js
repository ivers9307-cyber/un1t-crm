// PUT /api/presentations/[id]/slides/reorder — the gates, through the real
// withAuth wrapper: `presentations` somewhere, then at the deck's studio; a
// deck outside the caller's studios is a 404 (route.test.js covers the writes).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { PUT } = await import('./route.js')

const DECK = 'de000000-0000-4000-8000-000000000001'
const DECK_B = 'de000000-0000-4000-8000-000000000002'
const S1 = 'e1000000-0000-4000-8000-000000000001'
const S2 = 'e1000000-0000-4000-8000-000000000002'
let db
const put = (order, id = DECK) => PUT(
  new Request(`http://localhost/api/presentations/${id}/slides/reorder`, { method: 'PUT', body: JSON.stringify({ order }), headers: { 'content-type': 'application/json' } }),
  { params: Promise.resolve({ id }) },
)
const decks = (onA) => person({ [LOC_A]: { role: 'staff', permissions: { presentations: onA } }, [LOC_B]: { role: 'staff', permissions: { presentations: true } } }, LOC_B)
const positions = () => db.tables.presentation_slides.map((r) => [r.id, r.position])

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({
    tables: {
      presentations: [{ id: DECK, location_id: LOC_A, version: 1 }, { id: DECK_B, location_id: 'd0000000-0000-4000-8000-00000000000d', version: 1 }],
      presentation_slides: [
        { id: S1, presentation_id: DECK, location_id: LOC_A, position: 0, image_path: 'a.png' },
        { id: S2, presentation_id: DECK, location_id: LOC_A, position: 1, image_path: 'b.png' },
      ],
    },
    rpc: { bump_presentation_version: () => null },
  })
  createServerClient.mockReturnValue(db)
})

describe('PUT /api/presentations/[id]/slides/reorder — gates', () => {
  it('401 signed out (withAuth; it said 403 before)', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await put([S2, S1])).status).toBe(401)
  })

  it('403 without presentations at the deck\'s studio, nothing moved', async () => {
    getCurrentUser.mockResolvedValue(decks(false))
    const res = await put([S2, S1])
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Not authorised for presentations' })
    expect(positions()).toEqual([[S1, 0], [S2, 1]])
  })

  it('404 for a deck at a studio the caller is not at', async () => {
    getCurrentUser.mockResolvedValue(decks(true))
    expect((await put([S2, S1], DECK_B)).status).toBe(404)
  })

  it('saves the new order', async () => {
    getCurrentUser.mockResolvedValue(decks(true))
    const res = await put([S2, S1])
    expect(res.status).toBe(200)
    expect(positions()).toEqual([[S1, 1], [S2, 0]])
  })
})
