// MOBILE-UPLOAD.1 — submitInspection must always answer, never throw.
//
// A fault photo used to ride as a multipart part of the submit POST, and
// that has not left the device since Expo SDK 57 — so an inspection with a
// photo could not be submitted at all, and the failure was invisible. The
// photos now go device → Storage and the submit carries their paths.

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('./api', () => ({
  authHeaders: vi.fn(async () => ({ Authorization: 'Bearer jwt' })),
  API_BASE: 'https://crm.repset.ie',
}))
vi.mock('./supabase', () => ({ supabase: { storage: { from: vi.fn() } } }))
vi.mock('./upload-bytes', () => ({ readFileAsArrayBuffer: vi.fn() }))

import { authHeaders } from './api'
import { supabase } from './supabase'
import { readFileAsArrayBuffer } from './upload-bytes'
import { submitInspection } from './maintenance-api'
import { ISSUE_PHOTO_BUCKET } from './issues-api'

const LOC = 'a0000000-0000-0000-0000-000000000001'
const PATH = `${LOC}/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222-belt.jpg`
const PHOTO = { uri: 'file:///tmp/belt.jpg', name: 'belt.jpg', mimeType: 'image/jpeg' }
const RESULTS = { i1: { state: 'fail', note: 'fraying' }, i2: { state: 'pass' } }

let uploadToSignedUrl

beforeEach(() => {
  vi.clearAllMocks()
  uploadToSignedUrl = vi.fn(async () => ({ data: { path: PATH }, error: null }))
  supabase.storage.from.mockReturnValue({ uploadToSignedUrl })
  readFileAsArrayBuffer.mockResolvedValue(new ArrayBuffer(4096))
  global.fetch = vi.fn(async (url) =>
    String(url).endsWith('/upload-sign')
      ? { status: 200, json: async () => ({ success: true, slots: [{ path: PATH, token: 'tok' }] }) }
      : { status: 200, json: async () => ({ success: true, data: { inspection: { id: 'insp-1' }, issueId: 'iss-1' } }) }
  )
})

describe('submitInspection', () => {
  it('uploads the fault photo to the issue-photos bucket, then submits its path', async () => {
    const r = await submitInspection('insp-1', {
      results: RESULTS, note: 'belt', takeOutOfService: true, photos: [PHOTO], locationId: LOC,
    })
    expect(r.success).toBe(true)

    // The fault photo IS an issue photo — same bucket, same sign route.
    expect(global.fetch.mock.calls[0][0]).toBe('https://crm.repset.ie/api/issues/upload-sign')
    expect(supabase.storage.from).toHaveBeenCalledWith(ISSUE_PHOTO_BUCKET)

    const [url, init] = global.fetch.mock.calls[1]
    expect(url).toBe('https://crm.repset.ie/api/equipment/inspections/insp-1/submit')
    expect(JSON.parse(init.body)).toEqual({
      results: RESULTS,
      note: 'belt',
      takeOutOfService: true,
      photos: [{ path: PATH, file_name: 'belt.jpg', size: 4096, mime: 'image/jpeg' }],
    })
  })

  it('scopes every call to the inspector\'s active studio — the route 404s otherwise', async () => {
    await submitInspection('insp-1', { results: RESULTS, photos: [PHOTO], locationId: LOC })
    for (const call of authHeaders.mock.calls) {
      expect(call[0]).toMatchObject({ locationId: LOC })
    }
  })

  it('submits an all-pass run with no upload round-trip', async () => {
    const r = await submitInspection('insp-1', { results: RESULTS, photos: [], locationId: LOC })
    expect(r.success).toBe(true)
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(uploadToSignedUrl).not.toHaveBeenCalled()
  })

  it('answers an envelope when the network call rejects, rather than throwing', async () => {
    global.fetch = vi.fn(async () => { throw new TypeError('Network request failed') })
    const r = await submitInspection('insp-1', { results: RESULTS, photos: [PHOTO], locationId: LOC })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/network/i)
  })

  it('answers an envelope when the photo cannot be read', async () => {
    readFileAsArrayBuffer.mockRejectedValueOnce(new Error('ENOENT'))
    const r = await submitInspection('insp-1', { results: RESULTS, photos: [PHOTO], locationId: LOC })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/could not read/i)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('answers an envelope when the upload fails, and never submits half a report', async () => {
    uploadToSignedUrl.mockResolvedValueOnce({ data: null, error: { message: 'signature expired' } })
    const r = await submitInspection('insp-1', { results: RESULTS, photos: [PHOTO], locationId: LOC })
    expect(r.success).toBe(false)
    expect(global.fetch).toHaveBeenCalledTimes(1)   // sign only — never the submit
  })

  it('passes the server\'s `missing` list through so the screen can mark the ticks', async () => {
    global.fetch = vi.fn(async () => ({
      status: 400,
      json: async () => ({ success: false, error: 'Every item needs a mark.', missing: ['i2'] }),
    }))
    const r = await submitInspection('insp-1', { results: RESULTS, photos: [], locationId: LOC })
    expect(r.missing).toEqual(['i2'])
  })
})
