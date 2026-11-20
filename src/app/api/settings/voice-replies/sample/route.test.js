// VOICEREPLY.1 — POST /api/settings/voice-replies/sample through the real
// withAuth wrapper: an owner or manager at the active studio; ElevenLabs and
// the meter are faked.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/elevenlabs', async (importOriginal) => ({
  ...(await importOriginal()),
  listVoices: vi.fn(async () => ({ ok: true, voices: [{ voice_id: 'v1', name: 'One' }] })),
  synthesizeSpeech: vi.fn(async () => ({ ok: true, bytes: new Uint8Array([1, 2, 3]) })),
}))
vi.mock('@/lib/usage', () => ({ recordMeterUsage: vi.fn(async () => ({ ok: true })) }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { synthesizeSpeech } = await import('@/lib/elevenlabs')
const { recordMeterUsage } = await import('@/lib/usage')
const { POST } = await import('./route.js')

const post = (body = { voice_id: 'v1' }) => POST(new Request('http://localhost/api/settings/voice-replies/sample', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }))

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue(createFakeDb({ tables: { locations: [{ id: LOC_A, organization_id: 'f0000000-0000-4000-8000-0000000000f0' }] } }))
})

describe('POST /api/settings/voice-replies/sample', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await post()).status).toBe(401)
    expect(synthesizeSpeech).not.toHaveBeenCalled()
  })

  it('400 with no active studio', async () => {
    getCurrentUser.mockResolvedValue({ ...person({ [LOC_A]: { role: 'owner' } }, LOC_A), activeLocation: null })
    const res = await post()
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ success: false, error: 'No active location' })
  })

  it('404 when the active studio is not one of the caller\'s', async () => {
    getCurrentUser.mockResolvedValue({ ...person({ [LOC_A]: { role: 'owner' } }, LOC_A), activeLocation: { id: LOC_B } })
    expect((await post()).status).toBe(404)
    expect(synthesizeSpeech).not.toHaveBeenCalled()
  })

  it('403 for staff at the studio, no sample made', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'staff' } }, LOC_A))
    const res = await post()
    expect(res.status).toBe(403)
    expect(synthesizeSpeech).not.toHaveBeenCalled()
  })

  it('an owner gets the mp3, metered at the studio', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'owner' } }, LOC_A))
    const res = await post()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('audio/mpeg')
    expect(recordMeterUsage).toHaveBeenCalledTimes(2)
    expect(recordMeterUsage.mock.calls[0][0]).toMatchObject({ locationId: LOC_A, source: 'voice_reply_sample' })
  })
})
