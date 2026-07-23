// IG-MEDIA.1 — tests for the inbound Instagram media re-host IO.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ensureInstagramMediaRehosted } from './instagram-media-server'

// Minimal service-role client mock: records the upload + update calls.
function makeDb() {
  const calls = { upload: [], update: [] }
  const db = {
    storage: {
      from: (bucket) => ({
        upload: (path, bytes, opts) => {
          calls.upload.push({ bucket, path, bytes, opts })
          return Promise.resolve({ error: null })
        },
      }),
    },
    from: (table) => ({
      update: (patch) => ({
        eq: (col, val) => {
          calls.update.push({ table, patch, col, val })
          return Promise.resolve({ error: null })
        },
      }),
    }),
    _calls: calls,
  }
  return db
}

function fetchResponse({ ok = true, status = 200, contentType = 'image/jpeg', body = 'bytes' } = {}) {
  return {
    ok,
    status,
    headers: { get: (h) => (h.toLowerCase() === 'content-type' ? contentType : null) },
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  }
}

const MSG = { id: 'ig-msg-1', location_id: 'loc-1', message_type: 'image', media_url: 'https://lookaside.fbsbx.com/x.jpg' }

describe('ensureInstagramMediaRehosted', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('returns the existing path without fetching when already re-hosted', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const db = makeDb()
    const out = await ensureInstagramMediaRehosted(db, { ...MSG, media_storage_path: 'loc-1/ig-msg-1.jpg' })
    expect(out).toBe('loc-1/ig-msg-1.jpg')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns null when there is no media_url', async () => {
    const db = makeDb()
    expect(await ensureInstagramMediaRehosted(db, { ...MSG, media_url: null })).toBeNull()
  })

  it('downloads, uploads to the whatsapp-media bucket, persists path + mime', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fetchResponse({ contentType: 'image/png' })))
    const db = makeDb()
    const out = await ensureInstagramMediaRehosted(db, MSG)
    expect(out).toBe('loc-1/ig-msg-1.png') // ext derived from fetched mime
    expect(db._calls.upload[0]).toMatchObject({ bucket: 'whatsapp-media', path: 'loc-1/ig-msg-1.png' })
    expect(db._calls.update[0]).toMatchObject({
      table: 'instagram_messages',
      patch: { media_storage_path: 'loc-1/ig-msg-1.png', media_mime_type: 'image/png' },
      col: 'id', val: 'ig-msg-1',
    })
  })

  it('returns null when the CDN fetch fails (expired URL)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fetchResponse({ ok: false, status: 404 })))
    const db = makeDb()
    expect(await ensureInstagramMediaRehosted(db, MSG)).toBeNull()
    expect(db._calls.upload).toHaveLength(0)
  })

  it('retries with the connection token when the CDN returns 403', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(fetchResponse({ ok: false, status: 403 }))
      .mockResolvedValueOnce(fetchResponse({ contentType: 'image/jpeg' }))
    vi.stubGlobal('fetch', fetchSpy)
    const db = makeDb()
    const out = await ensureInstagramMediaRehosted(db, MSG, { token: 'IGTOKEN' })
    expect(out).toBe('loc-1/ig-msg-1.jpg')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    // second call carries the bearer token
    expect(fetchSpy.mock.calls[1][1]?.headers?.Authorization).toBe('Bearer IGTOKEN')
  })
})
