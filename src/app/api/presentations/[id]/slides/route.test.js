// POST /api/presentations/[id]/slides through the real withAuth wrapper:
// presentations somewhere, the deck's studio (404 outside), presentations
// there. Signed out is withAuth's 401 (it was a 403 before ROUTEWRAP.R11).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B, LOC_OTHER } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { POST } = await import('./route.js')

const DECK = 'ee000000-0000-4000-8000-000000000001'
const DECK_FAR = 'ee000000-0000-4000-8000-000000000002'
const post = (id) => {
  const form = new FormData()
  form.append('files', new File([new Uint8Array([1, 2, 3])], 'slide-1.png', { type: 'image/png' }))
  return POST(new Request(`http://localhost/api/presentations/${id}/slides`, { method: 'POST', body: form }), { params: Promise.resolve({ id }) })
}
const keyAt = (a, b) => person({ [LOC_A]: { role: 'manager', permissions: { presentations: a } }, [LOC_B]: { role: 'manager', permissions: { presentations: b } } }, LOC_A)
let db, upload

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({
    tables: {
      presentations: [{ id: DECK, location_id: LOC_B, version: 1 }, { id: DECK_FAR, location_id: LOC_OTHER, version: 1 }],
      presentation_slides: [],
    },
    rpc: { bump_presentation_version: () => null },
  })
  upload = vi.fn(async () => ({ error: null }))
  db.storage = { from: () => ({ upload }) }
  createServerClient.mockReturnValue(db)
})

describe('POST /api/presentations/[id]/slides', () => {
  it('401 signed out, nothing uploaded', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await post(DECK)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(upload).not.toHaveBeenCalled()
  })

  it('403 without presentations at the deck\'s studio', async () => {
    getCurrentUser.mockResolvedValue(keyAt(true, false))
    expect((await post(DECK)).status).toBe(403)
    expect(upload).not.toHaveBeenCalled()
  })

  it('404 for another studio\'s deck', async () => {
    getCurrentUser.mockResolvedValue(keyAt(true, true))
    expect((await post(DECK_FAR)).status).toBe(404)
    expect(upload).not.toHaveBeenCalled()
  })

  it('appends the slide at the deck\'s studio', async () => {
    getCurrentUser.mockResolvedValue(keyAt(false, true))
    const res = await post(DECK)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, added: 1 })
    expect(db.tables.presentation_slides).toHaveLength(1)
    expect(db.tables.presentation_slides[0].image_path.startsWith(`${LOC_B}/${DECK}/`)).toBe(true)
  })

  it('a refused upload is a 400 without the storage text', async () => {
    getCurrentUser.mockResolvedValue(keyAt(true, true))
    upload.mockResolvedValueOnce({ error: { message: 'secret detail' } })
    const res = await post(DECK)
    expect(res.status).toBe(400)
    expect(JSON.stringify(await res.json())).not.toContain('secret detail')
  })
})
