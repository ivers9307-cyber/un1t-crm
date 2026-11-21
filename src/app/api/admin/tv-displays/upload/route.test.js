// POST /api/admin/tv-displays/upload through the real withAuth wrapper:
// signed in (401; it was a 403 before), tv_displays web or mobile somewhere
// (403, the old text), the form, the studio (403 for one not the caller's)
// and tv_displays there, then the upload. A storage failure answers a fixed
// 400, never the storage text.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { POST } = await import('./route.js')

const TV_A = person({ [LOC_A]: { role: 'manager', permissions: { tv_displays: true } } }, LOC_A)
const NO_TV = person({ [LOC_A]: { role: 'staff', permissions: { tv_displays: false, mobile: { tv_displays: false } } } }, LOC_A)
const upload = (fields = {}) => {
  const fd = new FormData()
  fd.set('file', new File([new Uint8Array([1, 2, 3])], 'photo.png', { type: 'image/png' }))
  for (const [k, v] of Object.entries(fields)) fd.set(k, v)
  return POST(new Request('http://localhost/api/admin/tv-displays/upload', { method: 'POST', body: fd }))
}
let db, uploaded

beforeEach(() => {
  vi.clearAllMocks()
  uploaded = { error: null }
  db = createFakeDb()
  db.storage = { from: vi.fn(() => ({ upload: vi.fn(async () => uploaded) })) }
  createServerClient.mockReturnValue(db)
})

describe('POST /api/admin/tv-displays/upload', () => {
  it('401 signed out, nothing uploaded', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await upload()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(db.storage.from).not.toHaveBeenCalled()
  })

  it('403 without tv_displays anywhere, the old text', async () => {
    getCurrentUser.mockResolvedValue(NO_TV)
    const res = await upload()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Not authorised for TV displays' })
  })

  it('403 for a studio that is not the caller’s, nothing uploaded', async () => {
    getCurrentUser.mockResolvedValue(TV_A)
    const res = await upload({ location_id: LOC_B })
    expect(res.status).toBe(403)
    expect(db.storage.from).not.toHaveBeenCalled()
  })

  it('uploads under the studio’s folder', async () => {
    getCurrentUser.mockResolvedValue(TV_A)
    const res = await upload()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.path.startsWith(`${LOC_A}/`)).toBe(true)
    expect(db.storage.from).toHaveBeenCalledWith('tv-content')
  })

  it('a storage failure answers a fixed 400', async () => {
    getCurrentUser.mockResolvedValue(TV_A)
    uploaded = { error: { message: 'The resource already exists (bucket tv-content)' } }
    const res = await upload()
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ success: false, error: 'Could not upload the image. Try again.' })
  })
})
