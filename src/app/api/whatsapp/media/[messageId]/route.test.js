// ROUTEWRAP.R9 — GET /api/whatsapp/media/[messageId] on withAuth: signed out
// is withAuth's 401; a message at a studio the caller is not at is 404 (never
// 403, so ids are not enumerable); a member holding the inbox key at the
// message's studio (web or phone) gets a short-lived signed URL.
// INBOXPERM.1 — the inbox key is judged at the message's own studio.
// Ids are synthetic.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { person, LOC_A, LOC_B } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/whatsapp-media-server', () => ({ ensureMediaRehosted: vi.fn(), signedMediaUrl: vi.fn() }))

import { GET } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { ensureMediaRehosted, signedMediaUrl } from '@/lib/whatsapp-media-server'

const MSG = 'd0000000-0000-4000-8000-000000000001'
const IMAGE = { id: MSG, location_id: LOC_B, conversation_id: 'c1', message_type: 'image', media_mime_type: 'image/jpeg', media_url: null, media_external_id: 'synthetic', media_storage_path: null }

let message
const at = (a, b, active = LOC_A) => person({ [LOC_A]: { role: 'staff', permissions: a }, [LOC_B]: { role: 'staff', permissions: b } }, active)
const both = () => at({ whatsapp: true }, { whatsapp: true })
beforeEach(() => {
  vi.clearAllMocks()
  message = { ...IMAGE }
  getCurrentUser.mockResolvedValue(both())
  const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: message, error: null }) }
  createServerClient.mockReturnValue({ from: () => chain })
  ensureMediaRehosted.mockResolvedValue('wa/path.jpg')
  signedMediaUrl.mockResolvedValue('https://storage.example/signed')
})

const call = () => GET(new Request(`http://localhost/api/whatsapp/media/${MSG}`), { params: Promise.resolve({ messageId: MSG }) })
const nothingDone = () => {
  expect(ensureMediaRehosted).not.toHaveBeenCalled()
  expect(signedMediaUrl).not.toHaveBeenCalled()
}

describe('GET /api/whatsapp/media/[messageId]', () => {
  it('signed out is withAuth\'s 401, nothing re-hosted', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await call()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    nothingDone()
  })

  it('a message at a studio the caller is not at is 404, nothing re-hosted', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'owner', permissions: { whatsapp: true } } }, LOC_A))
    const res = await call()
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ success: false, error: 'Not found' })
    nothingDone()
  })

  it('a missing message, or one that is not media, is 404', async () => {
    message = null
    expect((await call()).status).toBe(404)
    message = { ...IMAGE, message_type: 'text', media_mime_type: null }
    expect((await call()).status).toBe(404)
    expect(ensureMediaRehosted).not.toHaveBeenCalled()
  })

  it('a member holding the key at the message\'s studio gets the signed URL', async () => {
    const res = await call()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, url: 'https://storage.example/signed', kind: 'image', mime_type: 'image/jpeg' })
  })

  it('403 with no inbox key anywhere, nothing re-hosted or signed', async () => {
    getCurrentUser.mockResolvedValue(at({ whatsapp: false }, { whatsapp: false }))
    expect((await call()).status).toBe(403)
    nothingDone()
  })

  it('403 when the key is held only at studio A and the message is at studio B (plain member): nothing re-hosted or signed', async () => {
    getCurrentUser.mockResolvedValue(at({ whatsapp: true }, { whatsapp: false }))
    expect((await call()).status).toBe(403)
    nothingDone()
  })

  it('allowed when the key is held at the message\'s studio though another studio is active', async () => {
    getCurrentUser.mockResolvedValue(at({ whatsapp: false }, { whatsapp: true }, LOC_A))
    expect((await call()).status).toBe(200)
  })

  it('the phone key alone is enough (the phone calls this route)', async () => {
    getCurrentUser.mockResolvedValue(at({ whatsapp: false }, { whatsapp: false, mobile: { whatsapp: true } }))
    expect((await call()).status).toBe(200)
  })
})
