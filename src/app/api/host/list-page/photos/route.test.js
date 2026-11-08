// HOSTPAGE.2 — host photo upload/delete for the public page: own host only,
// PNG/JPEG/WebP ≤5 MB, at most 12, files under host-photos/<host id>/ in the
// branding bucket; a delete only touches a URL the host's own list holds.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// The photo-URL check pins the project Supabase host (security review).
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://cdn.test'

let session
let hostRow
let updateError
vi.mock('@/lib/host-auth', () => ({ getCurrentHost: vi.fn(async () => session) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

const { POST, DELETE, HOST_PHOTO_MAX_BYTES } = await import('./route.js')

const H = 'a0000000-0000-4000-8000-0000000000a1'
const PUBLIC = (p) => `https://cdn.test/storage/v1/object/public/branding/${p}`
let db
let storage
function makeDb() {
  storage = { upload: vi.fn(async () => ({ error: null })), remove: vi.fn(async () => ({ error: null })), getPublicUrl: vi.fn((p) => ({ data: { publicUrl: PUBLIC(p) } })) }
  const update = vi.fn(() => ({ eq: vi.fn(async () => ({ error: updateError })) }))
  return {
    from: vi.fn(() => ({
      select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn(async () => ({ data: hostRow, error: null })) })) })),
      update,
    })),
    storage: { from: vi.fn(() => storage) },
    _update: update,
  }
}
const file = (type = 'image/jpeg', bytes = 1024, name = 'a.jpg') => new File([new Uint8Array(bytes)], name, { type })
function post(f) {
  const form = new FormData()
  if (f) form.append('file', f)
  return POST(new Request('https://crm.test/api/host/list-page/photos', { method: 'POST', body: form }))
}
const del = (url) => DELETE(new Request(`https://crm.test/api/host/list-page/photos?url=${encodeURIComponent(url)}`, { method: 'DELETE' }))

beforeEach(() => {
  vi.clearAllMocks()
  session = { host: { id: H, name: 'Acme' } }
  hostRow = { id: H, photos: [{ url: PUBLIC(`host-photos/${H}/old.jpg`), caption: 'Old' }] }
  updateError = null
  db = makeDb()
})

describe('POST /api/host/list-page/photos', () => {
  it('401 without a host session', async () => {
    session = null
    expect((await post(file())).status).toBe(401)
    expect(storage.upload).not.toHaveBeenCalled()
  })
  it('400 for a missing file, a GIF, or a file over 5 MB — before Storage', async () => {
    expect(HOST_PHOTO_MAX_BYTES).toBe(5 * 1024 * 1024)
    expect((await post(null)).status).toBe(400)
    expect((await post(file('image/gif', 10, 'a.gif'))).status).toBe(400)
    expect((await post(file('image/jpeg', HOST_PHOTO_MAX_BYTES + 1))).status).toBe(400)
    expect(storage.upload).not.toHaveBeenCalled()
  })
  it('400 photos_full at twelve', async () => {
    hostRow.photos = Array.from({ length: 12 }, (_, i) => ({ url: PUBLIC(`host-photos/${H}/${i}.jpg`), caption: null }))
    const res = await post(file())
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('photos_full')
    expect(storage.upload).not.toHaveBeenCalled()
  })
  it('uploads under host-photos/<host id>/ and appends to the list', async () => {
    const res = await post(file('image/webp', 2048, 'b.webp'))
    expect(res.status).toBe(200)
    const path = storage.upload.mock.calls[0][0]
    expect(path).toMatch(new RegExp(`^host-photos/${H}/[0-9a-f-]{36}\\.webp$`))
    expect(storage.upload.mock.calls[0][2]).toMatchObject({ contentType: 'image/webp', upsert: false })
    const body = await res.json()
    expect(body.url).toBe(PUBLIC(path))
    expect(body.data.photos).toEqual([{ url: PUBLIC(`host-photos/${H}/old.jpg`), caption: 'Old' }, { url: PUBLIC(path), caption: null }])
    expect(db._update).toHaveBeenCalledWith({ photos: body.data.photos })
  })
})

describe('DELETE /api/host/list-page/photos', () => {
  it('404 for a URL the host does not hold, or one outside host-photos/<host id>/; nothing removed', async () => {
    expect((await del('https://cdn.test/storage/v1/object/public/branding/host-photos/other/x.jpg')).status).toBe(404)
    hostRow.photos = [{ url: PUBLIC('race-hero/e1/hero.jpg'), caption: null }]
    expect((await del(PUBLIC('race-hero/e1/hero.jpg'))).status).toBe(404)
    expect(storage.remove).not.toHaveBeenCalled()
    expect(db._update).not.toHaveBeenCalled()
  })
  it('removes the object and the entry', async () => {
    const url = PUBLIC(`host-photos/${H}/old.jpg`)
    const res = await del(url)
    expect(res.status).toBe(200)
    expect(storage.remove).toHaveBeenCalledWith([`host-photos/${H}/old.jpg`])
    expect(db._update).toHaveBeenCalledWith({ photos: [] })
    expect((await res.json()).data.photos).toEqual([])
  })
})
