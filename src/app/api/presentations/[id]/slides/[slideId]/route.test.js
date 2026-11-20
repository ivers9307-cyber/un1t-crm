// DELETE /api/presentations/[id]/slides/[slideId] through the real withAuth
// wrapper: `presentations` somewhere, then at the deck's studio (the full role
// sweep is tests/role-sweep/presentations-and-timer.test.js).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { DELETE } = await import('./route.js')

const DECK = 'de000000-0000-4000-8000-000000000001'
const SLIDE = 'e1000000-0000-4000-8000-000000000001'
let db
let removed
const del = () => DELETE(new Request(`http://localhost/api/presentations/${DECK}/slides/${SLIDE}`, { method: 'DELETE' }), { params: Promise.resolve({ id: DECK, slideId: SLIDE }) })
const decks = (on) => person({ [LOC_A]: { role: 'staff', permissions: { presentations: on } }, [LOC_B]: { role: 'staff', permissions: { presentations: true } } }, LOC_B)
const build = (errors = {}) => {
  const d = createFakeDb({
    tables: {
      presentations: [{ id: DECK, location_id: LOC_A, version: 3 }],
      presentation_slides: [{ id: SLIDE, presentation_id: DECK, location_id: LOC_A, position: 0, image_path: 'deck/one.png' }],
    },
    rpc: { bump_presentation_version: () => null },
    errors,
  })
  d.storage = { from: () => ({ remove: async (paths) => { removed.push(...paths); return { error: null } } }) }
  return d
}

beforeEach(() => {
  vi.clearAllMocks()
  removed = []
  db = build()
  createServerClient.mockReturnValue(db)
})

describe('DELETE /api/presentations/[id]/slides/[slideId]', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await del()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('403 "Not authorised for presentations" without it at the deck’s studio, nothing deleted', async () => {
    getCurrentUser.mockResolvedValue(decks(false))
    const res = await del()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Not authorised for presentations' })
    expect(db.tables.presentation_slides).toHaveLength(1)
    expect(removed).toEqual([])
  })

  it('deletes the slide and its image, and bumps the deck', async () => {
    getCurrentUser.mockResolvedValue(decks(true))
    const res = await del()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
    expect(db.tables.presentation_slides).toEqual([])
    expect(removed).toEqual(['deck/one.png'])
    expect(db.calls.some((c) => c.rpc === 'bump_presentation_version')).toBe(true)
  })

  it('a failed delete is a 500 without the database text', async () => {
    getCurrentUser.mockResolvedValue(decks(true))
    createServerClient.mockReturnValue(build({ presentation_slides: { delete: { message: 'secret detail' } } }))
    const res = await del()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret detail')
  })
})
