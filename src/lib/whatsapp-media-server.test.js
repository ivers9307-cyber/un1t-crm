// WACONFIGFALLBACK.1 — inbound media is fetched from Meta with the message's
// location's OWN number token, never the global env token. No number (or a
// failed lookup) → null, the inbox's existing graceful gap. Ids synthetic.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./whatsapp-config', () => ({
  META_API_URL: 'https://graph.facebook.com/v21.0',
  getLocationWhatsAppNumberConfig: vi.fn(),
}))

import { ensureMediaRehosted } from './whatsapp-media-server.js'
import { getLocationWhatsAppNumberConfig } from './whatsapp-config'

const LOC = 'a0000000-0000-4000-8000-000000000001'
const MSG = { id: 'b0000000-0000-4000-8000-000000000002', location_id: LOC, message_type: 'image', media_mime_type: 'image/jpeg', media_external_id: '1000000000000001', media_storage_path: null }

function makeDb() {
  const uploads = []
  return {
    uploads,
    storage: { from: () => ({ upload: async (path) => { uploads.push(path); return { error: null } } }) },
    from: () => ({ update: () => ({ eq: async () => ({ error: null }) }) }),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  globalThis.fetch = vi.fn(async (url) => (String(url).includes('1000000000000001')
    ? { ok: true, json: async () => ({ url: 'https://lookaside.test/x', mime_type: 'image/jpeg' }) }
    : { ok: true, arrayBuffer: async () => new ArrayBuffer(4) }))
})

describe('ensureMediaRehosted — the location’s own number only', () => {
  it("fetches with the location's own token", async () => {
    getLocationWhatsAppNumberConfig.mockResolvedValue({ source: 'db', token: 'tok-synth', phoneNumberId: 'PNI-SYNTH' })
    const db = makeDb()
    const path = await ensureMediaRehosted(db, MSG)
    expect(path).toEqual(expect.any(String))
    expect(getLocationWhatsAppNumberConfig).toHaveBeenCalledWith(LOC)
    expect(globalThis.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer tok-synth')
  })

  it('no number at the location → null, Meta never called', async () => {
    getLocationWhatsAppNumberConfig.mockResolvedValue(null)
    const db = makeDb()
    expect(await ensureMediaRehosted(db, MSG)).toBeNull()
    expect(globalThis.fetch).not.toHaveBeenCalled()
    expect(db.uploads).toEqual([])
  })

  it('a failed lookup → null, Meta never called', async () => {
    getLocationWhatsAppNumberConfig.mockRejectedValue(new Error('db down'))
    expect(await ensureMediaRehosted(makeDb(), MSG)).toBeNull()
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})
