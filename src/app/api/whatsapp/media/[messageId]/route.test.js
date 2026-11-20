// ROUTEWRAP.R9 — GET /api/whatsapp/media/[messageId] on withAuth: signed out
// is withAuth's 401; a message at a studio the caller is not at is 404 (never
// 403, so ids are not enumerable); a member gets a short-lived signed URL.
// Ids are synthetic.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/whatsapp-media-server', () => ({ ensureMediaRehosted: vi.fn(), signedMediaUrl: vi.fn() }))

import { GET } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { ensureMediaRehosted, signedMediaUrl } from '@/lib/whatsapp-media-server'
import { LOC_A, LOC_B, person } from '../../../../../../tests/helpers/owner-at-location-callers.js'

const MSG = 'd0000000-0000-4000-8000-000000000001'
const IMAGE = { id: MSG, location_id: LOC_B, conversation_id: 'c1', message_type: 'image', media_mime_type: 'image/jpeg', media_url: null, media_external_id: 'synthetic', media_storage_path: null }

let message
beforeEach(() => {
  vi.clearAllMocks()
  message = { ...IMAGE }
  getCurrentUser.mockResolvedValue(person({ [LOC_A]: 'staff', [LOC_B]: 'staff' }, LOC_A))
  const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: message, error: null }) }
  createServerClient.mockReturnValue({ from: () => chain })
  ensureMediaRehosted.mockResolvedValue('wa/path.jpg')
  signedMediaUrl.mockResolvedValue('https://storage.example/signed')
})

const call = () => GET(new Request(`http://localhost/api/whatsapp/media/${MSG}`), { params: Promise.resolve({ messageId: MSG }) })

describe('GET /api/whatsapp/media/[messageId]', () => {
  it('signed out is withAuth\'s 401, nothing re-hosted', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await call()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(ensureMediaRehosted).not.toHaveBeenCalled()
  })

  it('a message at a studio the caller is not at is 404, nothing re-hosted', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: 'owner' }, LOC_A))
    const res = await call()
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ success: false, error: 'Not found' })
    expect(ensureMediaRehosted).not.toHaveBeenCalled()
  })

  it('a missing message, or one that is not media, is 404', async () => {
    message = null
    expect((await call()).status).toBe(404)
    message = { ...IMAGE, message_type: 'text', media_mime_type: null }
    expect((await call()).status).toBe(404)
    expect(ensureMediaRehosted).not.toHaveBeenCalled()
  })

  it('a member at the message\'s studio gets the signed URL', async () => {
    const res = await call()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, url: 'https://storage.example/signed', kind: 'image', mime_type: 'image/jpeg' })
  })
})
