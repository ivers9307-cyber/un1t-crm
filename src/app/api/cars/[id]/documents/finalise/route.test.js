// CARDOCUPLOAD.1 (C124) — POST /api/cars/[id]/documents/finalise records a
// car document the browser uploaded against a slot …/sign minted. The size
// and type are read back from Storage, never taken from the caller; an
// object that breaks the rules is removed; a good one becomes the same
// car_documents row + bookkeeper-queue entry the multipart route makes.
// The gate is swept in tests/role-sweep/cars.test.js; here the caller passes it.
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
import { enqueueFromCarDocument } from '@/lib/invoices-queue/enqueue'
import { POST } from './route.js'

const CAR = { id: 'c0000000-0000-0000-0000-000000000001', location_id: 'a0000000-0000-0000-0000-00000000000a' }
const SLOT_ID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const slot = (ext = 'pdf', docType = 'other') => `${CAR.id}/${docType}/${SLOT_ID}.${ext}`
const MB = 1024 * 1024
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(4), Buffer.from('mif1heic'), Buffer.alloc(64)])
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

let calls
/**
 * stored: the object Storage holds at the slot ({ size, mimetype, bytes }) or null.
 */
function fakeDb({ stored = { size: 12 * MB, mimetype: 'application/pdf', bytes: Buffer.from('%PDF-1.7') }, listError = null, downloadError = null, existing = [], existingError = null, insertError = null } = {}) {
  calls = { list: [], download: [], remove: [], inserted: null, existingQuery: null }
  const bucket = {
    list: vi.fn(async (folder, opts) => {
      calls.list.push([folder, opts])
      if (listError) return { data: null, error: listError }
      const name = slot().split('/').pop().replace(/\.pdf$/, '')
      return { data: stored ? [{ name: opts.search, metadata: { size: stored.size, mimetype: stored.mimetype } }, { name: `${name}-other.pdf`, metadata: {} }] : [], error: null }
    }),
    download: vi.fn(async (path) => {
      calls.download.push(path)
      if (downloadError) return { data: null, error: downloadError }
      return { data: new Blob([stored.bytes]), error: null }
    }),
    remove: vi.fn(async (paths) => { calls.remove.push(paths); return { data: [], error: null } }),
  }
  return {
    from: (table) => {
      if (table === 'cars') return { select: () => ({ eq: () => ({ single: async () => ({ data: CAR, error: null }) }) }) }
      if (table === 'car_documents') {
        return {
          select: (cols) => {
            const chain = []
            const q = {
              eq: (c, v) => { chain.push([c, v]); return q },
              limit: async () => { calls.existingQuery = { cols, chain }; return { data: existingError ? null : existing, error: existingError } },
            }
            return q
          },
          insert: (row) => {
            calls.inserted = row
            return { select: () => ({ single: async () => (insertError ? { data: null, error: insertError } : { data: { id: 'd1', ...row }, error: null }) }) }
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
    storage: { from: vi.fn(() => bucket) },
  }
}

const finalise = (body) => POST(
  new Request('http://localhost/api/cars/x/documents/finalise', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }),
  { params: Promise.resolve({ id: CAR.id }) },
)
const good = { doc_type: 'other', path: slot(), file_name: 'Invoice.PDF', mime: 'application/pdf' }

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue({ id: 'u1', locations: [{ id: CAR.location_id }] })
  createServerClient.mockReturnValue(fakeDb())
})

describe('POST /api/cars/[id]/documents/finalise — a good upload', () => {
  it('records a 12 MB PDF exactly as the multipart route does (row, queue, 201 shape)', async () => {
    const res = await finalise({ ...good, notes: 'from the port' })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.id).toBe('d1')
    expect(body.queue_warning).toBeUndefined()
    expect(calls.inserted).toEqual({
      car_id: CAR.id,
      doc_type: 'other',
      storage_path: slot(),
      filename: 'Invoice.PDF',
      mime_type: 'application/pdf',
      size_bytes: 12 * MB,
      uploaded_by: 'u1',
      notes: 'from the port',
    })
    expect(enqueueFromCarDocument).toHaveBeenCalledWith('d1')
    expect(calls.list).toEqual([[`${CAR.id}/other`, { search: `${SLOT_ID}.pdf` }]])
    expect(calls.download).toEqual([])
    expect(calls.remove).toEqual([])
  })

  it('takes the size from Storage, never from the caller', async () => {
    await finalise({ ...good, size: 1 })
    expect(calls.inserted.size_bytes).toBe(12 * MB)
  })

  it('stores notes as null when none are sent', async () => {
    await finalise(good)
    expect(calls.inserted.notes).toBeNull()
  })

  it('answers queue_warning when the bookkeeper queue insert fails (the document stays)', async () => {
    enqueueFromCarDocument.mockResolvedValueOnce({ ok: false, error: 'queue down' })
    const res = await finalise(good)
    expect(res.status).toBe(201)
    expect((await res.json()).queue_warning).toBe('queue down')
    expect(calls.remove).toEqual([])
  })

  it('an alias declared type records the canonical type Storage holds', async () => {
    createServerClient.mockReturnValue(fakeDb({ stored: { size: 5 * MB, mimetype: 'image/jpeg' } }))
    const res = await finalise({ ...good, path: slot('jpg'), mime: 'image/jpg' })
    expect(res.status).toBe(201)
    expect(calls.inserted.mime_type).toBe('image/jpeg')
  })

  it('an unlabelled HEIC is judged by the bytes Storage holds', async () => {
    createServerClient.mockReturnValue(fakeDb({ stored: { size: 3 * MB, mimetype: 'image/heic', bytes: HEIC } }))
    const res = await finalise({ ...good, path: slot('heic'), file_name: 'IMG_0001.HEIC', mime: '' })
    expect(res.status).toBe(201)
    expect(calls.download).toEqual([slot('heic')])
    expect(calls.inserted.mime_type).toBe('image/heic')
  })
})

describe('POST /api/cars/[id]/documents/finalise — refusals', () => {
  it.each([
    ['another car', `c0000000-0000-0000-0000-000000000002/other/${SLOT_ID}.pdf`],
    ['another doc type', slot('pdf', 'nct_invoice')],
    ['a caller-chosen name', `${CAR.id}/other/invoice.pdf`],
    ['traversal', `${CAR.id}/other/../../cars/${SLOT_ID}.pdf`],
    ['the Xero invoice folder', `cars/${CAR.id}/${SLOT_ID}.pdf`],
  ])('refuses a path for %s with a 400 and touches nothing in Storage', async (_what, path) => {
    const res = await finalise({ ...good, path })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('That is not an upload slot for this car.')
    expect(calls.list).toEqual([])
    expect(calls.remove).toEqual([])
    expect(calls.inserted).toBeNull()
  })

  it('refuses an unknown doc_type', async () => {
    const res = await finalise({ ...good, doc_type: 'bogus' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Invalid doc_type')
  })

  it('answers 400 when nothing arrived at the slot', async () => {
    createServerClient.mockReturnValue(fakeDb({ stored: null }))
    const res = await finalise(good)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('The file did not finish uploading. Try again.')
    expect(calls.inserted).toBeNull()
  })

  it('answers 500 when Storage cannot be read', async () => {
    createServerClient.mockReturnValue(fakeDb({ listError: { message: 'storage down' } }))
    const res = await finalise(good)
    expect(res.status).toBe(500)
    expect(calls.inserted).toBeNull()
  })

  it('does not record the same upload twice (409, the object is kept)', async () => {
    createServerClient.mockReturnValue(fakeDb({ existing: [{ id: 'd0' }] }))
    const res = await finalise(good)
    expect(res.status).toBe(409)
    expect(calls.existingQuery.chain).toEqual([['car_id', CAR.id], ['storage_path', slot()]])
    expect(calls.inserted).toBeNull()
    expect(calls.remove).toEqual([])
  })

  it('answers 500 when the duplicate check fails, and records nothing', async () => {
    createServerClient.mockReturnValue(fakeDb({ existingError: { message: 'timeout' } }))
    const res = await finalise(good)
    expect(res.status).toBe(500)
    expect(calls.inserted).toBeNull()
  })

  it('removes a stored object over 25 MiB and answers 400', async () => {
    createServerClient.mockReturnValue(fakeDb({ stored: { size: 25 * MB + 1, mimetype: 'application/pdf' } }))
    const res = await finalise(good)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('File too large (max 25 MB)')
    expect(calls.remove).toEqual([[slot()]])
    expect(calls.inserted).toBeNull()
  })

  it('removes an empty stored object', async () => {
    createServerClient.mockReturnValue(fakeDb({ stored: { size: 0, mimetype: 'application/pdf' } }))
    const res = await finalise(good)
    expect(res.status).toBe(400)
    expect(calls.remove).toEqual([[slot()]])
  })

  it('removes an unlabelled upload whose stored bytes are not a listed type', async () => {
    createServerClient.mockReturnValue(fakeDb({ stored: { size: MB, mimetype: 'image/png', bytes: Buffer.from('hello, not a document') } }))
    const res = await finalise({ ...good, path: slot('png'), mime: '' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Unsupported file type (PDF, JPEG, PNG, GIF, WebP or HEIC)')
    expect(calls.remove).toEqual([[slot('png')]])
    expect(calls.inserted).toBeNull()
  })

  it('removes an upload whose declared type is off the list', async () => {
    const res = await finalise({ ...good, mime: 'text/html' })
    expect(res.status).toBe(400)
    expect(calls.remove).toEqual([[slot()]])
    expect(calls.download).toEqual([])
  })

  it('removes an upload whose stored type is not the type it was judged to be', async () => {
    // Declared PDF, but the bytes went up labelled PNG: the row would say one
    // thing and Storage would serve another.
    createServerClient.mockReturnValue(fakeDb({ stored: { size: MB, mimetype: 'image/png', bytes: PNG } }))
    const res = await finalise(good)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("The uploaded file's type does not match. Pick it again.")
    expect(calls.remove).toEqual([[slot()]])
    expect(calls.inserted).toBeNull()
  })

  it('removes an upload stored as a type other than the one its slot was minted for', async () => {
    // Sign minted a .pdf slot; the token does not pin the Content-Type, so a
    // PNG uploaded there and declared as PNG agrees with Storage but not with
    // the slot: the row would say PNG under a .pdf name.
    createServerClient.mockReturnValue(fakeDb({ stored: { size: MB, mimetype: 'image/png', bytes: PNG } }))
    const res = await finalise({ ...good, mime: 'image/png' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("The uploaded file's type does not match. Pick it again.")
    expect(calls.remove).toEqual([[slot()]])
    expect(calls.inserted).toBeNull()
  })

  it('removes the object and answers 500 when the stored bytes cannot be read', async () => {
    createServerClient.mockReturnValue(fakeDb({ stored: { size: MB, mimetype: 'image/heic', bytes: HEIC }, downloadError: { message: 'gone' } }))
    const res = await finalise({ ...good, path: slot('heic'), mime: '' })
    expect(res.status).toBe(500)
    expect(calls.remove).toEqual([[slot('heic')]])
    expect(calls.inserted).toBeNull()
  })

  it('the losing insert of a concurrent finalise (23505 on the unique path, mig 693) answers 409 and keeps the object', async () => {
    createServerClient.mockReturnValue(fakeDb({ insertError: {
      code: '23505', message: 'duplicate key value violates unique constraint "car_documents_storage_path_key"',
    } }))
    const res = await finalise(good)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ success: false, error: 'This upload is already saved.' })
    expect(calls.remove).toEqual([])
    expect(enqueueFromCarDocument).not.toHaveBeenCalled()
  })

  it('removes the object and answers 500 when the row insert fails', async () => {
    createServerClient.mockReturnValue(fakeDb({ insertError: { message: 'insert refused' } }))
    const res = await finalise(good)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'insert refused' })
    expect(calls.remove).toEqual([[slot()]])
    expect(enqueueFromCarDocument).not.toHaveBeenCalled()
  })
})
