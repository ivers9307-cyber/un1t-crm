// Tests for POST /api/contacts/[id]/consultation-photos (CONSULTATIONS SP1)
//
// Coverage:
//   - POST with a valid image → 200, row inserted with right fields, storage_path
//     starts with consultations/<contactId>/
//   - POST with a non-image file → 400, no row inserted, no upload
//   - POST with an oversized file → 400, no row inserted, no upload
//   - POST when storage.upload returns an error → 400, no row inserted
//   - POST without consultations permission → 403
//   - POST missing contact → 404

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccess: (user, locationId) => {
    if (!user) return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 })
    if (!locationId) return null
    const allowed = (user.locations || []).some((l) => l.id === locationId)
    if (!allowed) return new Response(JSON.stringify({ success: false, error: 'Forbidden' }), { status: 403 })
    return null
  },
  assertLocationAccessOr404: (user, locationId) => {
    if (!user) return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 })
    if (!locationId) return null
    const allowed = (user.locations || []).some((l) => l.id === locationId)
    if (!allowed) return new Response(JSON.stringify({ success: false, error: 'Not found' }), { status: 404 })
    return null
  },
}))

vi.mock('@/lib/permissions', () => ({
  hasPermission: vi.fn(() => true),
}))

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'

// ─── IDs ─────────────────────────────────────────────────────────────────────

const CONTACT_ID = 'a0000000-0000-0000-0000-000000000001'
const USER_ID    = 'b0000000-0000-0000-0000-000000000002'
const LOC_ID     = 'c0000000-0000-0000-0000-000000000003'
const PHOTO_ID   = 'd0000000-0000-0000-0000-000000000004'

const CONTACT = { id: CONTACT_ID, location_id: LOC_ID }
const OWNER   = { id: USER_ID, role: 'owner', locations: [{ id: LOC_ID }] }

// ─── File helpers ─────────────────────────────────────────────────────────────

function makeFile({ type = 'image/jpeg', size = 1024, name = 'photo.jpg' } = {}) {
  // Build a minimal File-like object that the route can consume.
  const bytes = new Uint8Array(size)
  const file = new File([bytes], name, { type })
  return file
}

// ─── DB mock helpers ──────────────────────────────────────────────────────────

function makeDb({ uploadErr = null, insertErr = null, insertedRow = null, signedUrl = 'https://signed.url/photo.jpg' } = {}) {
  const uploadSpy = vi.fn(() => Promise.resolve({ error: uploadErr }))
  const removeSpy = vi.fn(() => Promise.resolve({ error: null }))
  const createSignedUrlSpy = vi.fn(() => Promise.resolve({
    data: signedUrl ? { signedUrl } : null,
    error: null,
  }))

  const insertSpy = vi.fn(() => ({
    select: vi.fn(() => ({
      single: vi.fn(() => Promise.resolve({
        data: insertedRow || {
          id: PHOTO_ID,
          contact_id: CONTACT_ID,
          location_id: LOC_ID,
          storage_path: `consultations/${CONTACT_ID}/uuid.jpg`,
          created_by: USER_ID,
          label: null,
          caption: null,
          consultation_id: null,
        },
        error: insertErr,
      })),
    })),
  }))

  const db = {
    from: vi.fn((table) => {
      if (table === 'contacts') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn(() => Promise.resolve({ data: CONTACT, error: null })),
            })),
          })),
        }
      }
      if (table === 'consultation_photos') {
        return { insert: insertSpy }
      }
      throw new Error(`unexpected table: ${table}`)
    }),
    storage: {
      from: vi.fn(() => ({
        upload: uploadSpy,
        remove: removeSpy,
        createSignedUrl: createSignedUrlSpy,
      })),
    },
  }

  return { db, uploadSpy, removeSpy, createSignedUrlSpy, insertSpy }
}

function makeDbContactMissing() {
  return {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          single: vi.fn(() => Promise.resolve({ data: null, error: { message: 'not found' } })),
        })),
      })),
    })),
    storage: { from: vi.fn() },
  }
}

// ─── Request helpers ──────────────────────────────────────────────────────────

const BASE_URL = `http://localhost/api/contacts/${CONTACT_ID}/consultation-photos`

function postReq(file, fields = {}) {
  const formData = new FormData()
  if (file) formData.set('file', file)
  for (const [k, v] of Object.entries(fields)) {
    formData.set(k, v)
  }
  return new Request(BASE_URL, { method: 'POST', body: formData })
}

const props = { params: { id: CONTACT_ID } }

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  hasPermission.mockReturnValue(true)
  getCurrentUser.mockResolvedValue(OWNER)
})

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/contacts/[id]/consultation-photos', () => {
  it('uploads a valid image and inserts a row with correct fields', async () => {
    const { db, uploadSpy, insertSpy } = makeDb()
    createServerClient.mockReturnValue(db)

    const file = makeFile({ type: 'image/jpeg', size: 512, name: 'front.jpg' })
    const res = await POST(postReq(file, { label: 'Front', caption: 'Day 1' }), props)

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)

    // Storage upload was called once
    expect(uploadSpy).toHaveBeenCalledOnce()

    // The path passed to upload starts with consultations/<contactId>/
    const [[storagePath]] = uploadSpy.mock.calls
    expect(storagePath).toMatch(new RegExp(`^consultations/${CONTACT_ID}/`))

    // Insert was called with the right fields
    expect(insertSpy).toHaveBeenCalledWith(expect.objectContaining({
      contact_id:  CONTACT_ID,
      location_id: LOC_ID,
      created_by:  USER_ID,
      label:       'Front',
      caption:     'Day 1',
    }))
  })

  it('storage_path in the insert matches the path passed to upload', async () => {
    let capturedPath = null
    const uploadSpy = vi.fn((path) => {
      capturedPath = path
      return Promise.resolve({ error: null })
    })
    let capturedInsertPayload = null
    const insertSpy = vi.fn((payload) => {
      capturedInsertPayload = payload
      return {
        select: vi.fn(() => ({
          single: vi.fn(() => Promise.resolve({
            data: { id: PHOTO_ID, ...payload },
            error: null,
          })),
        })),
      }
    })
    const db = {
      from: vi.fn((table) => {
        if (table === 'contacts') return { select: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn(() => Promise.resolve({ data: CONTACT, error: null })) })) })) }
        if (table === 'consultation_photos') return { insert: insertSpy }
        throw new Error(`unexpected table: ${table}`)
      }),
      storage: {
        from: vi.fn(() => ({
          upload: uploadSpy,
          remove: vi.fn(() => Promise.resolve({ error: null })),
          createSignedUrl: vi.fn(() => Promise.resolve({ data: { signedUrl: 'https://x' }, error: null })),
        })),
      },
    }
    createServerClient.mockReturnValue(db)

    const file = makeFile({ type: 'image/png', name: 'back.png' })
    await POST(postReq(file), props)

    expect(capturedInsertPayload.storage_path).toBe(capturedPath)
    expect(capturedPath).toMatch(new RegExp(`^consultations/${CONTACT_ID}/`))
  })

  it('returns 400 for a non-image file and does NOT upload or insert', async () => {
    const { db, uploadSpy, insertSpy } = makeDb()
    createServerClient.mockReturnValue(db)

    const file = new File(['data'], 'document.pdf', { type: 'application/pdf' })
    const res = await POST(postReq(file), props)

    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.success).toBe(false)
    expect(json.error).toMatch(/image/i)
    expect(uploadSpy).not.toHaveBeenCalled()
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('returns 400 for an oversized file and does NOT upload or insert', async () => {
    const { db, uploadSpy, insertSpy } = makeDb()
    createServerClient.mockReturnValue(db)

    const TOO_LARGE = 11 * 1024 * 1024  // 11 MB > 10 MB limit
    const file = makeFile({ type: 'image/jpeg', size: TOO_LARGE })
    const res = await POST(postReq(file), props)

    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.success).toBe(false)
    expect(json.error).toMatch(/too large/i)
    expect(uploadSpy).not.toHaveBeenCalled()
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('returns 400 when storage.upload errors and does NOT insert a row', async () => {
    const { db, insertSpy } = makeDb({ uploadErr: { message: 'bucket quota exceeded' } })
    createServerClient.mockReturnValue(db)

    const file = makeFile({ type: 'image/jpeg' })
    const res = await POST(postReq(file), props)

    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.success).toBe(false)
    expect(json.error).toMatch(/upload failed/i)
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('returns 403 without consultations permission', async () => {
    hasPermission.mockReturnValue(false)
    const { db } = makeDb()
    createServerClient.mockReturnValue(db)

    const file = makeFile()
    const res = await POST(postReq(file), props)

    expect(res.status).toBe(403)
    const json = await res.json()
    expect(json.success).toBe(false)
  })

  it('returns 404 when the contact does not exist', async () => {
    createServerClient.mockReturnValue(makeDbContactMissing())

    const file = makeFile()
    const res = await POST(postReq(file), props)

    expect(res.status).toBe(404)
    const json = await res.json()
    expect(json.success).toBe(false)
    expect(json.error).toMatch(/not found/i)
  })

  it('passes optional fields (label, caption, consultation_id, taken_at) through to insert', async () => {
    let capturedPayload = null
    const insertSpy = vi.fn((payload) => {
      capturedPayload = payload
      return {
        select: vi.fn(() => ({
          single: vi.fn(() => Promise.resolve({ data: { id: PHOTO_ID, ...payload }, error: null })),
        })),
      }
    })
    const db = {
      from: vi.fn((table) => {
        if (table === 'contacts') return { select: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn(() => Promise.resolve({ data: CONTACT, error: null })) })) })) }
        if (table === 'consultation_photos') return { insert: insertSpy }
        throw new Error(`unexpected: ${table}`)
      }),
      storage: {
        from: vi.fn(() => ({
          upload: vi.fn(() => Promise.resolve({ error: null })),
          remove: vi.fn(() => Promise.resolve({ error: null })),
          createSignedUrl: vi.fn(() => Promise.resolve({ data: { signedUrl: 'https://x' }, error: null })),
        })),
      },
    }
    createServerClient.mockReturnValue(db)

    const CONS_ID = 'f0000000-0000-0000-0000-000000000006'
    const file = makeFile()
    await POST(postReq(file, {
      label:           'Side view',
      caption:         'Week 4',
      consultation_id: CONS_ID,
      taken_at:        '2026-06-15T09:00:00Z',
    }), props)

    expect(capturedPayload.label).toBe('Side view')
    expect(capturedPayload.caption).toBe('Week 4')
    expect(capturedPayload.consultation_id).toBe(CONS_ID)
    expect(capturedPayload.taken_at).toBe('2026-06-15T09:00:00Z')
  })
})
