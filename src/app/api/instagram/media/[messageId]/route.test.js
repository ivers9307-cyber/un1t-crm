// ROUTEWRAP.R10 — GET /api/instagram/media/[messageId] through the real withAuth
// wrapper: signed out is the wrapper's 401, the inbox permission is 403, a
// message at another studio is 404, and a stored media file is signed.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/instagram-media-server', () => ({ ensureInstagramMediaRehosted: vi.fn(async (_db, m) => m.media_storage_path) }))
vi.mock('@/lib/whatsapp-media-server', () => ({ signedMediaUrl: vi.fn(async (_db, p) => `https://signed.example/${p}`) }))
const { ensureInstagramMediaRehosted } = await import('@/lib/instagram-media-server')
const { signedMediaUrl } = await import('@/lib/whatsapp-media-server')

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { GET } = await import('./route.js')

const M_A = 'a1000000-0000-4000-8000-0000000000a1'
const M_B = 'a1000000-0000-4000-8000-0000000000b2'
const get = (id) => GET(new Request(`http://localhost/api/instagram/media/${id}`), { params: Promise.resolve({ messageId: id }) })
const staff = (on = true) => person({ [LOC_A]: { role: 'staff', permissions: { whatsapp: on } } }, LOC_A)

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue(createFakeDb({
    tables: {
      instagram_messages: [
        { id: M_A, location_id: LOC_A, message_type: 'image', media_mime_type: 'image/jpeg', media_storage_path: 'ig/a.jpg' },
        { id: M_B, location_id: LOC_B, message_type: 'image', media_mime_type: 'image/jpeg', media_storage_path: 'ig/b.jpg' },
      ],
    },
  }))
})

describe('GET /api/instagram/media/[messageId]', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await get(M_A)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('403 without the inbox permission', async () => {
    getCurrentUser.mockResolvedValue(staff(false))
    expect((await get(M_A)).status).toBe(403)
  })

  it('404 for a message at another studio', async () => {
    getCurrentUser.mockResolvedValue(staff())
    const res = await get(M_B)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ success: false, error: 'Not found' })
  })

  it('signs the stored media', async () => {
    getCurrentUser.mockResolvedValue(staff())
    const res = await get(M_A)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, url: 'https://signed.example/ig/a.jpg', kind: 'image' })
  })
})

describe('INBOXPERM.1 — the inbox key is judged at the message\'s studio, web OR phone', () => {
  const at = (a, b, active = LOC_A) => person({ [LOC_A]: { role: 'staff', permissions: a }, [LOC_B]: { role: 'staff', permissions: b } }, active)
  const nothingDone = () => {
    expect(ensureInstagramMediaRehosted).not.toHaveBeenCalled()
    expect(signedMediaUrl).not.toHaveBeenCalled()
  }

  it('403 when the key is held only at studio A and the message is at studio B (plain member): no re-host, no signed URL', async () => {
    getCurrentUser.mockResolvedValue(at({ whatsapp: true }, { whatsapp: false }))
    const res = await get(M_B)
    expect(res.status).toBe(403)
    nothingDone()
  })

  it('allowed when the key is held at the message\'s studio though another studio is active', async () => {
    getCurrentUser.mockResolvedValue(at({ whatsapp: false }, { whatsapp: true }))
    const res = await get(M_B)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ url: 'https://signed.example/ig/b.jpg' })
  })

  it('the phone key alone is enough (WAMediaThumb calls this route)', async () => {
    getCurrentUser.mockResolvedValue(at({ whatsapp: false, mobile: { whatsapp: true } }, { whatsapp: false }))
    expect((await get(M_A)).status).toBe(200)
  })

  it('404 for a non-member of the message\'s studio, nothing re-hosted or signed', async () => {
    getCurrentUser.mockResolvedValue(staff())
    expect((await get(M_B)).status).toBe(404)
    nothingDone()
  })
})
