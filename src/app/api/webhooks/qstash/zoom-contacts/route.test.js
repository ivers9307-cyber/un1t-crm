import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/qstash', () => ({
  verifyQStashSignature: vi.fn(() => ({ ok: true, matched: 'current' })),
  ZOOM_CONTACTS_WORKER_PATH: '/api/webhooks/qstash/zoom-contacts',
}))
vi.mock('@/lib/app-url', () => ({ getAppUrl: vi.fn(() => 'https://x.test') }))
vi.mock('@/lib/zoom/external-contacts', () => ({
  createContact: vi.fn(async () => ({ ok: true })),
  updateContact: vi.fn(async () => ({ ok: true })),
  deleteContact: vi.fn(async () => ({ ok: true })),
}))

import { verifyQStashSignature } from '@/lib/qstash'
import { createContact, updateContact, deleteContact } from '@/lib/zoom/external-contacts'
import { POST } from './route'

const post = (body) => new Request('https://x.test/api/webhooks/qstash/zoom-contacts', {
  method: 'POST',
  headers: { 'upstash-signature': 'sig' },
  body: JSON.stringify(body),
})

beforeEach(() => {
  vi.mocked(verifyQStashSignature).mockReturnValue({ ok: true, matched: 'current' })
  vi.mocked(createContact).mockResolvedValue({ ok: true })
  vi.mocked(updateContact).mockResolvedValue({ ok: true })
  vi.mocked(deleteContact).mockResolvedValue({ ok: true })
})

describe('POST /api/webhooks/qstash/zoom-contacts', () => {
  it('401s on a bad signature', async () => {
    vi.mocked(verifyQStashSignature).mockReturnValue({ ok: false, reason: 'malformed' })
    const res = await POST(post({ op: 'create', e164: '+353871111111', name: 'A', contactId: 'u1' }))
    expect(res.status).toBe(401)
    expect(createContact).not.toHaveBeenCalled()
  })

  it('503s when our own signing keys are unset', async () => {
    vi.mocked(verifyQStashSignature).mockReturnValue({ ok: false, reason: 'missing_keys' })
    const res = await POST(post({ op: 'create', e164: '+353871111111', name: 'A', contactId: 'u1' }))
    expect(res.status).toBe(503)
  })

  it('applies a create', async () => {
    const res = await POST(post({ op: 'create', e164: '+353871111111', name: 'Aoife Ryan', contactId: 'u1' }))
    expect(res.status).toBe(200)
    expect(createContact).toHaveBeenCalledWith({ e164: '+353871111111', name: 'Aoife Ryan', contactId: 'u1' })
  })

  it('applies an update', async () => {
    const res = await POST(post({ op: 'update', e164: '+353871111111', name: 'New', contactId: 'u2', zoomId: 'z1' }))
    expect(res.status).toBe(200)
    expect(updateContact).toHaveBeenCalledWith({ zoomId: 'z1', name: 'New', contactId: 'u2' })
  })

  it('applies a delete', async () => {
    const res = await POST(post({ op: 'delete', e164: '+353871111111', zoomId: 'z1' }))
    expect(res.status).toBe(200)
    expect(deleteContact).toHaveBeenCalledWith({ zoomId: 'z1' })
  })

  it('400s on an unknown op without retrying forever', async () => {
    const res = await POST(post({ op: 'explode', e164: '+353871111111' }))
    expect(res.status).toBe(400)
  })

  it('400s on malformed JSON', async () => {
    const req = new Request('https://x.test/api/webhooks/qstash/zoom-contacts', {
      method: 'POST', headers: { 'upstash-signature': 'sig' }, body: 'not json',
    })
    expect((await POST(req)).status).toBe(400)
  })

  it('500s on a Zoom failure so QStash retries', async () => {
    vi.mocked(createContact).mockResolvedValue({ ok: false, error: 'zoom 500' })
    const res = await POST(post({ op: 'create', e164: '+353871111111', name: 'A', contactId: 'u1' }))
    expect(res.status).toBe(500)
  })
})
