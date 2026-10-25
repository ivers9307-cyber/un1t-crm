// REPORT-ISSUE.3 — the submit path must ALWAYS answer, and never throw.
//
// The defect this file exists for (reported 2026-09-08): tapping "Send
// report" with a photo attached left the button spinning on "Sending…"
// forever, with no error and nothing submitted. submitIssue() awaited a
// bare fetch() carrying a multipart FormData body; when that rejected on
// the device, nothing caught it — not here, not in the screen's onSubmit —
// so setSubmitting(false) never ran. Production logs are the proof: the
// same phone session shows GET /api/issues 200 four times and not one
// POST. A rejected promise became a permanent spinner.
//
// So: every failure mode below must come back as { success: false, error },
// because the screen can only clear its spinner if this function returns.
//
// `./api`, `./supabase` and `./upload-bytes` are mocked BEFORE import —
// they pull the React-Native runtime, which must never load under vitest's
// Node environment (see vitest.config.js).

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
import { submitIssue, ISSUE_PHOTO_BUCKET } from './issues-api'

const LOC = 'a0000000-0000-0000-0000-000000000001'
const PATH = `${LOC}/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222-photo-1.jpg`
const PHOTO = { uri: 'file:///tmp/IMG_0001.jpg', name: 'IMG_0001.jpg', mimeType: 'image/jpeg' }

/** Response double for the JSON wrappers. */
function jsonRes(body, status = 200) {
  return { status, json: async () => body }
}

let uploadToSignedUrl

beforeEach(() => {
  vi.clearAllMocks()
  uploadToSignedUrl = vi.fn(async () => ({ data: { path: PATH }, error: null }))
  supabase.storage.from.mockReturnValue({ uploadToSignedUrl })
  readFileAsArrayBuffer.mockResolvedValue(new ArrayBuffer(2048))
  global.fetch = vi.fn(async (url) =>
    String(url).endsWith('/upload-sign')
      ? jsonRes({ success: true, draft_id: 'draft-1', slots: [{ path: PATH, token: 'tok' }] })
      : jsonRes({ success: true, data: { id: 'issue-1' } }, 201)
  )
})

describe('submitIssue — a failure must always come back as an envelope', () => {
  it('answers an envelope when the network call rejects (the forever-spinner bug)', async () => {
    global.fetch = vi.fn(async () => { throw new TypeError('Network request failed') })
    const r = await submitIssue({ description: 'Broken bench', photos: [PHOTO], locationId: LOC })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/network/i)
  })

  it('gives up on a stalled upload instead of spinning forever', async () => {
    vi.useFakeTimers()
    try {
      // A request that never settles — the exact shape of a phone on a dead
      // link mid-upload. The old code awaited this with no timeout.
      global.fetch = vi.fn(() => new Promise(() => {}))
      const pending = submitIssue({ description: 'Broken bench', photos: [], locationId: LOC })
      await vi.advanceTimersByTimeAsync(60_000)
      const r = await pending
      expect(r.success).toBe(false)
      expect(r.error).toMatch(/timed out/i)
    } finally {
      vi.useRealTimers()
    }
  })

  it('answers an envelope when the session refresh throws', async () => {
    authHeaders.mockRejectedValueOnce(new SyntaxError('JSON Parse error'))
    const r = await submitIssue({ description: 'Broken bench', photos: [], locationId: LOC })
    expect(r.success).toBe(false)
    expect(r.error).toBeTruthy()
  })

  it('answers an envelope when the photo cannot be read off the device', async () => {
    readFileAsArrayBuffer.mockRejectedValueOnce(new Error('ENOENT'))
    const r = await submitIssue({ description: 'Broken bench', photos: [PHOTO], locationId: LOC })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/could not read/i)
    // Nothing was signed or posted — we failed before touching the network.
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('answers an envelope when the file reads back empty', async () => {
    readFileAsArrayBuffer.mockResolvedValueOnce(new ArrayBuffer(0))
    const r = await submitIssue({ description: 'Broken bench', photos: [PHOTO], locationId: LOC })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/empty/i)
  })

  it('answers an envelope when the sign step refuses', async () => {
    global.fetch = vi.fn(async () => jsonRes({ success: false, error: 'Photos must be under 10 MB each.' }, 400))
    const r = await submitIssue({ description: 'Broken bench', photos: [PHOTO], locationId: LOC })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/10 MB/)
  })

  it('answers an envelope when the direct-to-storage upload errors', async () => {
    uploadToSignedUrl.mockResolvedValueOnce({ data: null, error: { message: 'signature expired' } })
    const r = await submitIssue({ description: 'Broken bench', photos: [PHOTO], locationId: LOC })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/signature expired/)
  })

  it('answers an envelope when the finalise body is not JSON', async () => {
    global.fetch = vi.fn(async (url) =>
      String(url).endsWith('/upload-sign')
        ? jsonRes({ success: true, slots: [{ path: PATH, token: 'tok' }] })
        : { status: 413, json: async () => { throw new SyntaxError('Unexpected token <') } }
    )
    const r = await submitIssue({ description: 'Broken bench', photos: [PHOTO], locationId: LOC })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/413/)
  })
})

describe('submitIssue — the happy paths', () => {
  it('sends the photo bytes straight to storage, then finalises with the path', async () => {
    const r = await submitIssue({ description: 'Broken bench', photos: [PHOTO], locationId: LOC })
    expect(r).toEqual({ success: true, data: { id: 'issue-1' } })

    const [signUrl, signInit] = global.fetch.mock.calls[0]
    expect(signUrl).toBe('https://crm.repset.ie/api/issues/upload-sign')
    expect(JSON.parse(signInit.body)).toEqual({
      files: [{ file_name: 'IMG_0001.jpg', size: 2048, mime: 'image/jpeg' }],
    })

    // The bytes go to Storage, NOT through the API — a multipart body of
    // three photos could never fit Vercel's ~4.5 MB request cap anyway.
    expect(supabase.storage.from).toHaveBeenCalledWith(ISSUE_PHOTO_BUCKET)
    expect(uploadToSignedUrl).toHaveBeenCalledWith(PATH, 'tok', expect.any(ArrayBuffer), { contentType: 'image/jpeg' })

    const [finaliseUrl, finaliseInit] = global.fetch.mock.calls[1]
    expect(finaliseUrl).toBe('https://crm.repset.ie/api/issues')
    expect(JSON.parse(finaliseInit.body)).toEqual({
      description: 'Broken bench',
      photos: [{ path: PATH, file_name: 'IMG_0001.jpg', size: 2048, mime: 'image/jpeg' }],
    })
  })

  it('skips signing and uploading entirely for a text-only report', async () => {
    const r = await submitIssue({ description: 'Shower 2 runs cold', photos: [], locationId: LOC })
    expect(r.success).toBe(true)
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(global.fetch.mock.calls[0][0]).toBe('https://crm.repset.ie/api/issues')
    expect(uploadToSignedUrl).not.toHaveBeenCalled()
  })

  it('files the report at the location the screen named, not the server default', async () => {
    await submitIssue({ description: 'Broken bench', photos: [], locationId: LOC })
    // Every call carries x-active-location via authHeaders({ locationId }).
    for (const call of authHeaders.mock.calls) {
      expect(call[0]).toMatchObject({ locationId: LOC })
    }
  })

  it('caps at three photos — the server refuses a fourth', async () => {
    global.fetch = vi.fn(async (url) =>
      String(url).endsWith('/upload-sign')
        ? jsonRes({
            success: true,
            slots: [1, 2, 3].map((n) => ({ path: `${PATH}-${n}`, token: `tok-${n}` })),
          })
        : jsonRes({ success: true, data: { id: 'issue-1' } }, 201)
    )
    await submitIssue({ description: 'x', photos: [PHOTO, PHOTO, PHOTO, PHOTO], locationId: LOC })
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).files).toHaveLength(3)
  })

  it('refuses to send a photo when the server hands back fewer slots than photos', async () => {
    global.fetch = vi.fn(async (url) =>
      String(url).endsWith('/upload-sign')
        ? jsonRes({ success: true, slots: [{ path: PATH, token: 'tok' }] })
        : jsonRes({ success: true, data: { id: 'issue-1' } }, 201)
    )
    const r = await submitIssue({ description: 'x', photos: [PHOTO, PHOTO], locationId: LOC })
    expect(r.success).toBe(false)
    expect(uploadToSignedUrl).not.toHaveBeenCalled()
  })
})
