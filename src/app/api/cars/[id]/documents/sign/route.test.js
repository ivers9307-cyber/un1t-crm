// CARDOCUPLOAD.1 (C124) — POST /api/cars/[id]/documents/sign mints a signed
// upload slot for a car document. The gate (car_processing at the car's
// studio) is swept in tests/role-sweep/cars.test.js; here the caller passes it.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(), assertLocationAccessOr404: vi.fn(() => null) }))
vi.mock('@/lib/permissions', () => ({
  hasPermissionAtAnyLocation: vi.fn(() => true), hasPermissionForLocation: vi.fn(() => true),
}))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn() }))

import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { POST } from './route.js'

const CAR = { id: 'c0000000-0000-0000-0000-000000000001', location_id: 'a0000000-0000-0000-0000-00000000000a' }
const b64 = (bytes) => Buffer.from(bytes).toString('base64')
const PNG_HEAD = b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const PDF_HEAD = b64(Buffer.from('%PDF-1.7\n'))
const HEIC_HEAD = b64(Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(4), Buffer.from('mif1heic')]))
const TEXT_HEAD = b64(Buffer.from('hello, not a document'))
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

let createSignedUploadUrl, bucketFrom
function fakeDb({ signError = null } = {}) {
  createSignedUploadUrl = vi.fn(async (path) => (signError
    ? { data: null, error: signError }
    : { data: { path, token: 'signed-token', signedUrl: 'https://x' }, error: null }))
  bucketFrom = vi.fn(() => ({ createSignedUploadUrl }))
  return {
    from: (table) => {
      if (table === 'cars') return { select: () => ({ eq: () => ({ single: async () => ({ data: CAR, error: null }) }) }) }
      throw new Error(`unexpected table ${table}`)
    },
    storage: { from: bucketFrom },
  }
}

const sign = (body) => POST(
  new Request('http://localhost/api/cars/x/documents/sign', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }),
  { params: Promise.resolve({ id: CAR.id }) },
)
const good = { doc_type: 'other', file_name: 'Invoice.PDF', mime: 'application/pdf', size: 12 * 1024 * 1024 }

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue({ id: 'u1', locations: [{ id: CAR.location_id }] })
  createServerClient.mockReturnValue(fakeDb())
})

describe('POST /api/cars/[id]/documents/sign — the slot', () => {
  it('mints <car>/<doc_type>/<uuid>.pdf in car-documents for a 12 MB PDF and returns path, token and the type to upload as', async () => {
    const res = await sign(good)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ success: true, token: 'signed-token', content_type: 'application/pdf' })
    expect(body.path).toMatch(new RegExp(`^${CAR.id}/other/${UUID}\\.pdf$`))
    expect(bucketFrom).toHaveBeenCalledWith('car-documents')
    expect(createSignedUploadUrl).toHaveBeenCalledWith(body.path)
  })

  it('mints a new slot every time (the caller never chooses the name)', async () => {
    const a = await (await sign(good)).json()
    const b = await (await sign({ ...good, file_name: '../../x.pdf' })).json()
    expect(a.path).not.toBe(b.path)
    expect(b.path).toMatch(new RegExp(`^${CAR.id}/other/${UUID}\\.pdf$`))
  })

  it('answers 500 when Storage will not sign', async () => {
    createServerClient.mockReturnValue(fakeDb({ signError: { message: 'bucket gone' } }))
    const res = await sign(good)
    expect(res.status).toBe(500)
    expect((await res.json()).error).toContain('bucket gone')
  })
})

describe('POST /api/cars/[id]/documents/sign — types (the multipart route\'s rules)', () => {
  it.each([
    ['image/jpg', 'image/jpeg', 'jpg'],
    ['application/x-pdf', 'application/pdf', 'pdf'],
    ['image/heic', 'image/heic', 'heic'],
    ['IMAGE/PNG', 'image/png', 'png'],
  ])('uploads %s as the listed type %s (Storage checks the Content-Type against the bucket list)', async (declared, stored, ext) => {
    const body = await (await sign({ ...good, mime: declared })).json()
    expect(body.content_type).toBe(stored)
    expect(body.path.endsWith(`.${ext}`)).toBe(true)
  })

  it.each([
    ['', HEIC_HEAD, 'image/heic'],
    ['application/octet-stream', HEIC_HEAD, 'image/heic'],
    ['', PNG_HEAD, 'image/png'],
    ['', PDF_HEAD, 'application/pdf'],
  ])('judges an unlabelled file (%j) by the first bytes the browser sends', async (mime, head, stored) => {
    const res = await sign({ ...good, file_name: 'IMG_0001.HEIC', mime, head })
    expect(res.status).toBe(200)
    expect((await res.json()).content_type).toBe(stored)
  })

  it.each([
    ['an unlabelled file with unknown bytes', { mime: '', head: TEXT_HEAD }],
    ['an unlabelled file with no bytes sent', { mime: '' }],
    ['a Word file', { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }],
    ['HTML, whatever its bytes', { mime: 'text/html', head: PDF_HEAD }],
    ['an SVG', { mime: 'image/svg+xml' }],
  ])('refuses %s with a 400 and never signs', async (_what, over) => {
    const res = await sign({ ...good, ...over })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ success: false, error: 'Unsupported file type (PDF, JPEG, PNG, GIF, WebP or HEIC)' })
    expect(createSignedUploadUrl).not.toHaveBeenCalled()
  })
})

describe('POST /api/cars/[id]/documents/sign — size and body', () => {
  it('accepts exactly 25 MiB', async () => {
    expect((await sign({ ...good, size: 25 * 1024 * 1024 })).status).toBe(200)
  })

  it('refuses a file over 25 MiB before signing', async () => {
    const res = await sign({ ...good, size: 25 * 1024 * 1024 + 1 })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('File too large (max 25 MB)')
    expect(createSignedUploadUrl).not.toHaveBeenCalled()
  })

  it('refuses an empty file', async () => {
    const res = await sign({ ...good, size: 0 })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('The file is empty. Pick it again.')
  })

  it('refuses an unknown doc_type', async () => {
    const res = await sign({ ...good, doc_type: 'bogus' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Invalid doc_type')
    expect(createSignedUploadUrl).not.toHaveBeenCalled()
  })

  it('refuses a head longer than the sniffers read, and a missing file name', async () => {
    expect((await sign({ ...good, mime: '', head: 'A'.repeat(2000) })).status).toBe(400)
    expect((await sign({ ...good, file_name: undefined })).status).toBe(400)
    expect(createSignedUploadUrl).not.toHaveBeenCalled()
  })
})
