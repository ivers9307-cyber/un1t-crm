// CARDOCBUCKET.1 — POST /api/cars/[id]/documents stores only the seven
// car-document types (src/lib/car-document-media.js), judges an unlabelled
// file by its bytes, and refuses everything else with a 400 BEFORE Storage
// is called (the bucket, mig 687, would refuse it with a 500-shaped error).
// Gates are covered by tests/role-sweep/cars.test.js; here the caller passes them.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(), assertLocationAccessOr404: vi.fn(() => null) }))
vi.mock('@/lib/permissions', () => ({
  hasPermissionAtAnyLocation: vi.fn(() => true), hasPermissionForLocation: vi.fn(() => true),
}))
vi.mock('@/lib/invoices-queue/enqueue', () => ({ enqueueFromCarDocument: vi.fn(async () => ({ ok: true })) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn() }))

import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { POST } from './route.js'

const CAR = { id: 'c0000000-0000-0000-0000-000000000001', location_id: 'a0000000-0000-0000-0000-00000000000a' }
const PDF = Buffer.from('%PDF-1.7\n%fake\n')
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const TEXT = Buffer.from('hello, not a document')
// An iPhone HEIC's first box: size 24, 'ftyp', major 'heic', minor 0, compatible 'mif1' 'heic'.
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(4), Buffer.from('mif1heic')])

let upload, inserted
function fakeDb() {
  upload = vi.fn(async () => ({ data: { path: 'x' }, error: null }))
  inserted = null
  return {
    from: (table) => {
      if (table === 'cars') {
        return { select: () => ({ eq: () => ({ single: async () => ({ data: CAR, error: null }) }) }) }
      }
      if (table === 'car_documents') {
        return {
          insert: (row) => {
            inserted = row
            return { select: () => ({ single: async () => ({ data: { id: 'd1', ...row }, error: null }) }) }
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
    storage: { from: () => ({ upload, remove: vi.fn(async () => ({ error: null })) }) },
  }
}

function post(bytes, { name = 'invoice.pdf', type = 'application/pdf' } = {}) {
  const fd = new FormData()
  fd.append('file', new File([bytes], name, { type }))
  fd.append('doc_type', 'other')
  return POST(new Request('http://localhost/api/cars/x/documents', { method: 'POST', body: fd }),
    { params: Promise.resolve({ id: CAR.id }) })
}

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue({ id: 'u1', locations: [{ id: CAR.location_id }] })
  createServerClient.mockReturnValue(fakeDb())
})

describe('POST /api/cars/[id]/documents — types', () => {
  it('stores a PDF as application/pdf', async () => {
    const res = await post(PDF)
    expect(res.status).toBe(201)
    expect(upload.mock.calls[0][2]).toEqual({ contentType: 'application/pdf', upsert: false })
    expect(inserted.mime_type).toBe('application/pdf')
  })

  it('stores a HEIC photo Safari labelled', async () => {
    const res = await post(Buffer.from('....ftypheic'), { name: 'photo.heic', type: 'image/heic' })
    expect(res.status).toBe(201)
    expect(upload.mock.calls[0][2].contentType).toBe('image/heic')
  })

  it('judges an unlabelled file by its bytes (main stored it as application/octet-stream)', async () => {
    const res = await post(PNG, { name: 'scan', type: '' })
    expect(res.status).toBe(201)
    expect(upload.mock.calls[0][2].contentType).toBe('image/png')
    expect(inserted.mime_type).toBe('image/png')
  })

  it('stores an unlabelled HEIC (Chrome/Firefox on Windows send no type) as image/heic', async () => {
    const res = await post(HEIC, { name: 'IMG_0001.HEIC', type: '' })
    expect(res.status).toBe(201)
    expect(upload.mock.calls[0][2].contentType).toBe('image/heic')
    expect(inserted.mime_type).toBe('image/heic')
  })

  it('stores a HEIC labelled application/octet-stream as image/heic', async () => {
    const res = await post(HEIC, { name: 'IMG_0001.HEIC', type: 'application/octet-stream' })
    expect(res.status).toBe(201)
    expect(upload.mock.calls[0][2].contentType).toBe('image/heic')
  })

  it.each([
    ['image/jpg', 'image/jpeg', JPEG],
    ['image/pjpeg', 'image/jpeg', JPEG],
    ['application/x-pdf', 'application/pdf', PDF],
  ])('sends Storage the listed type for the alias %s (the bucket checks the Content-Type it is sent)', async (alias, stored, bytes) => {
    const res = await post(bytes, { name: 'x', type: alias })
    expect(res.status).toBe(201)
    expect(upload.mock.calls[0][2].contentType).toBe(stored)
    expect(inserted.mime_type).toBe(stored)
  })

  it.each([
    ['a Word file', TEXT, 'quote.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['an SVG', TEXT, 'x.svg', 'image/svg+xml'],
    ['HTML', TEXT, 'x.html', 'text/html'],
    ['an unlabelled file with unknown bytes', TEXT, 'blob', ''],
  ])('refuses %s with a 400 and never calls Storage (main stored it)', async (_what, bytes, name, type) => {
    const res = await post(bytes, { name, type })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ success: false, error: 'Unsupported file type (PDF, JPEG, PNG, GIF, WebP or HEIC)' })
    expect(upload).not.toHaveBeenCalled()
    expect(inserted).toBeNull()
  })

  it('refuses a file over 25 MiB before reading it', async () => {
    const big = new File([new Uint8Array(1)], 'big.pdf', { type: 'application/pdf' })
    Object.defineProperty(big, 'size', { value: 26214401 })
    const fd = new FormData()
    fd.append('file', big)
    fd.append('doc_type', 'other')
    const req = new Request('http://localhost/api/cars/x/documents', { method: 'POST' })
    req.formData = async () => fd
    const res = await POST(req, { params: Promise.resolve({ id: CAR.id }) })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('File too large (max 25 MB)')
    expect(upload).not.toHaveBeenCalled()
  })
})

// CARDOCUPLOAD.1 — the row, rollback and queue moved into
// src/lib/car-document-record.js (shared with …/documents/finalise); the
// multipart route's answers are unchanged.
describe('POST /api/cars/[id]/documents — recording (shared with finalise)', () => {
  it('removes the stored file and answers 500 when the row insert fails', async () => {
    const remove = vi.fn(async () => ({ error: null }))
    const db = fakeDb()
    db.from = (table) => table === 'cars'
      ? { select: () => ({ eq: () => ({ single: async () => ({ data: CAR, error: null }) }) }) }
      : { insert: () => ({ select: () => ({ single: async () => ({ data: null, error: { message: 'insert refused' } }) }) }) }
    db.storage = { from: () => ({ upload, remove }) }
    createServerClient.mockReturnValue(db)
    const res = await post(PDF)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'insert refused' })
    expect(remove).toHaveBeenCalledWith([upload.mock.calls[0][0]])
  })

  it('still answers 201 with queue_warning when the bookkeeper queue insert fails', async () => {
    const { enqueueFromCarDocument } = await import('@/lib/invoices-queue/enqueue')
    enqueueFromCarDocument.mockResolvedValueOnce({ ok: false, error: 'queue down' })
    const res = await post(PDF)
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.queue_warning).toBe('queue down')
    expect(enqueueFromCarDocument).toHaveBeenCalledWith('d1')
  })

  it('answers 500, not 404, when the car read fails', async () => {
    const db = fakeDb()
    db.from = () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: null, error: { code: '57014', message: 'timeout' } }) }) }) })
    createServerClient.mockReturnValue(db)
    const res = await post(PDF)
    expect(res.status).toBe(500)
    expect(upload).not.toHaveBeenCalled()
  })

  it('answers 404 for a car that does not exist', async () => {
    const db = fakeDb()
    db.from = () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: null, error: { code: 'PGRST116', message: '0 rows' } }) }) }) })
    createServerClient.mockReturnValue(db)
    const res = await post(PDF)
    expect(res.status).toBe(404)
  })
})
