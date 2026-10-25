// TVUPLOAD.1 (C93) — the phone's TV image upload goes straight to Storage.
//
// uploadTvImage used to post multipart with a `{uri}` file part to
// /api/admin/tv-displays/upload. Since Expo SDK 57 such a part never leaves
// the phone (no request, no status, nothing in the logs), so Push → Photo and
// a template's base image had silently stopped uploading. It now reads the
// bytes into an ArrayBuffer (never a Blob: a zero-byte object on RN), signs a
// slot, uploads to the 'tv-content' bucket with the slot's token, and
// finalises. The contract is the old one: { success, path } or
// { success: false, error }, and it never throws (both callers await it and
// then clear their spinner).

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: { apiBaseUrl: 'https://crm.test' } } } }))
vi.mock('./api', () => ({
  authHeaders: vi.fn(async ({ json } = {}) => ({ Authorization: 'Bearer jwt', ...(json ? { 'Content-Type': 'application/json' } : {}) })),
  API_BASE: 'https://crm.test',
}))
vi.mock('./supabase', () => ({ supabase: { storage: { from: vi.fn() } } }))
vi.mock('./upload-bytes', () => ({ readFileAsArrayBuffer: vi.fn() }))

import { authHeaders } from './api'
import { supabase } from './supabase'
import { readFileAsArrayBuffer } from './upload-bytes'
import { uploadTvImage } from './tv-api'

const LOC = '0a000000-0000-4000-8000-000000000001'
const PATH = `${LOC}/1c000000-0000-4000-8000-000000000003.jpg`
const BYTES = new ArrayBuffer(2048)
const PHOTO = { uri: 'file:///cache/pick.jpg', name: 'pick.jpg', mimeType: 'image/jpeg' }

let uploadToSignedUrl
const ok = (body) => ({ status: 200, ok: true, json: async () => body })

beforeEach(() => {
  vi.clearAllMocks()
  uploadToSignedUrl = vi.fn(async () => ({ data: { path: PATH }, error: null }))
  supabase.storage.from.mockReturnValue({ uploadToSignedUrl })
  readFileAsArrayBuffer.mockResolvedValue(BYTES)
  global.fetch = vi.fn(async (url) => (String(url).endsWith('/sign')
    ? ok({ success: true, path: PATH, token: 'tok' })
    : ok({ success: true, path: PATH })))
})

describe('uploadTvImage (TVUPLOAD.1)', () => {
  it('signs, uploads the bytes to tv-content with the token, finalises, and returns the path', async () => {
    const res = await uploadTvImage(PHOTO, LOC)
    expect(res).toEqual({ success: true, path: PATH })

    const [signUrl, signInit] = global.fetch.mock.calls[0]
    expect(signUrl).toBe('https://crm.test/api/admin/tv-displays/upload/sign')
    expect(signInit.method).toBe('POST')
    expect(JSON.parse(signInit.body)).toEqual({ kind: 'content', location_id: LOC, file_name: 'pick.jpg', mime: 'image/jpeg', size: 2048 })
    expect(authHeaders).toHaveBeenCalledWith({ locationId: LOC, json: true })

    expect(supabase.storage.from).toHaveBeenCalledWith('tv-content')
    expect(uploadToSignedUrl).toHaveBeenCalledWith(PATH, 'tok', BYTES, { contentType: 'image/jpeg' })

    const [finUrl, finInit] = global.fetch.mock.calls[1]
    expect(finUrl).toBe('https://crm.test/api/admin/tv-displays/upload/finalise')
    expect(JSON.parse(finInit.body)).toEqual({ kind: 'content', location_id: LOC, path: PATH })
  })

  it('never posts multipart (the SDK 57 dead path)', async () => {
    await uploadTvImage(PHOTO, LOC)
    for (const [, init] of global.fetch.mock.calls) {
      expect(typeof init.body).toBe('string')
      expect(init.body).not.toBeInstanceOf(FormData)
    }
  })

  it('a template base image is signed and finalised as kind template', async () => {
    await uploadTvImage(PHOTO, LOC, 'template')
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).kind).toBe('template')
    expect(JSON.parse(global.fetch.mock.calls[1][1].body).kind).toBe('template')
  })

  it('an unknown picker type falls back to the name, then to JPEG', async () => {
    await uploadTvImage({ uri: 'file:///x.png', name: 'x.png' }, LOC)
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).mime).toBe('image/png')
  })

  it('a file it cannot read: an envelope, nothing signed', async () => {
    readFileAsArrayBuffer.mockRejectedValue(new Error('gone'))
    const res = await uploadTvImage(PHOTO, LOC)
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/Could not read/)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('a refused sign (a HEIC, no permission): the server\'s words, nothing uploaded', async () => {
    global.fetch = vi.fn(async () => ({ status: 400, ok: false, json: async () => ({ success: false, error: 'File must be a PNG, JPEG, WebP, GIF or AVIF image.' }) }))
    const res = await uploadTvImage(PHOTO, LOC)
    expect(res).toEqual({ success: false, error: 'File must be a PNG, JPEG, WebP, GIF or AVIF image.' })
    expect(uploadToSignedUrl).not.toHaveBeenCalled()
  })

  it('a Storage refusal: an envelope, never finalised', async () => {
    uploadToSignedUrl.mockResolvedValue({ data: null, error: { message: 'payload too large' } })
    const res = await uploadTvImage(PHOTO, LOC)
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/payload too large/)
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('a refused finalise: the server\'s words', async () => {
    global.fetch = vi.fn(async (url) => (String(url).endsWith('/sign')
      ? ok({ success: true, path: PATH, token: 'tok' })
      : { status: 400, ok: false, json: async () => ({ success: false, error: 'The image did not finish uploading. Try again.' }) }))
    expect(await uploadTvImage(PHOTO, LOC)).toEqual({ success: false, error: 'The image did not finish uploading. Try again.' })
  })

  it('a dropped connection or an unreadable body is an envelope, never a throw', async () => {
    global.fetch = vi.fn(async () => { throw new Error('Network request failed') })
    const dropped = await uploadTvImage(PHOTO, LOC)
    expect(dropped.success).toBe(false)
    expect(dropped.error).toMatch(/Network request failed/)

    global.fetch = vi.fn(async () => ({ status: 502, ok: false, json: async () => { throw new SyntaxError('Unexpected token') } }))
    const garbled = await uploadTvImage(PHOTO, LOC)
    expect(garbled.success).toBe(false)
    expect(garbled.error).toMatch(/502/)
  })
})
