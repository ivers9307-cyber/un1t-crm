import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/elevenlabs', async (importOriginal) => ({ ...(await importOriginal()), listVoices: vi.fn(), synthesizeSpeech: vi.fn() }))
vi.mock('@/lib/usage', () => ({ recordMeterUsage: vi.fn(async () => {}) }))

import { POST } from './route'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { listVoices, synthesizeSpeech } from '@/lib/elevenlabs'
import { recordMeterUsage } from '@/lib/usage'

const OGG = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 1])
const MP3 = new Uint8Array([0xff, 0xfb, 1])
const userAt = (role) => ({ id: 'u-1', profileRole: 'staff', role, activeLocation: { id: 'loc-1' }, locations: [{ id: 'loc-1' }], rolesByLocation: { 'loc-1': role } })
let settings
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('ELEVENLABS_API_KEY', 'el-key')
  settings = { voice_replies: { voices: { default: { voice_id: 'v2', name: 'Brian' } } } }
  getCurrentUser.mockResolvedValue(userAt('manager'))
  listVoices.mockResolvedValue({ ok: true, voices: [{ voice_id: 'v1', name: 'Aoife' }, { voice_id: 'v2', name: 'Brian' }] })
  createServerClient.mockReturnValue({ from: () => { const b = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: { organization_id: 'org-1', settings }, error: null }) }; return b } })
})
afterEach(() => vi.unstubAllEnvs())
const run = async () => { const r = await POST(new Request('http://x/api/settings/voice-replies/check', { method: 'POST' })); return { status: r.status, json: await r.json() } }

describe('POST /api/settings/voice-replies/check', () => {
  test('both models accepted and Ogg: ready, using the studio voice', async () => {
    synthesizeSpeech.mockResolvedValue({ ok: true, bytes: OGG, mime: 'audio/ogg' })
    const { status, json } = await run()
    expect(status).toBe(200)
    expect(json.data).toEqual({
      key: true,
      voices: { ok: true, count: 2, tested: 'Brian' },
      models: [
        { model: 'eleven_v4_turbo', accepted: true, status: null, ogg: true },
        { model: 'eleven_flash_v2_5', accepted: true, status: null, ogg: true },
      ],
      inUse: 'eleven_v4_turbo',
      ready: true,
    })
    expect(synthesizeSpeech.mock.calls.map(([a]) => [a.voiceId, a.modelId, a.outputFormat])).toEqual([
      ['v2', 'eleven_v4_turbo', 'opus_48000_64'], ['v2', 'eleven_flash_v2_5', 'opus_48000_64'],
    ])
    expect(recordMeterUsage.mock.calls.every(([e]) => e.meter === 'elevenlabs_tts_characters')).toBe(true)
  })
  test('v4 Turbo refused, Flash fine: not ready, both reported', async () => {
    synthesizeSpeech.mockImplementation(async ({ modelId }) => (modelId === 'eleven_v4_turbo' ? { ok: false, reason: 'http_error', status: 422 } : { ok: true, bytes: OGG, mime: 'audio/ogg' }))
    const { json } = await run()
    expect(json.data.models).toEqual([
      { model: 'eleven_v4_turbo', accepted: false, status: 422, ogg: null },
      { model: 'eleven_flash_v2_5', accepted: true, status: null, ogg: true },
    ])
    expect(json.data.ready).toBe(false)
  })
  test('audio that is not Ogg: not ready', async () => {
    synthesizeSpeech.mockResolvedValue({ ok: true, bytes: MP3, mime: 'audio/ogg' })
    const { json } = await run()
    expect(json.data.models.every((m) => m.ogg === false)).toBe(true)
    expect(json.data.ready).toBe(false)
  })
  test('no key: says so, calls nothing', async () => {
    vi.stubEnv('ELEVENLABS_API_KEY', '')
    const { json } = await run()
    expect(json.data).toMatchObject({ key: false, ready: false, models: [] })
    expect(listVoices).not.toHaveBeenCalled()
    expect(synthesizeSpeech).not.toHaveBeenCalled()
  })
  test('voice list unreadable: reported, no speech', async () => {
    listVoices.mockResolvedValue({ ok: false, reason: 'http_error', status: 401 })
    const { json } = await run()
    expect(json.data).toMatchObject({ key: true, voices: { ok: false, count: 0, tested: null }, models: [], ready: false })
  })
  test('no saved voice: tests the first voice on the account', async () => {
    settings = {}
    synthesizeSpeech.mockResolvedValue({ ok: true, bytes: OGG, mime: 'audio/ogg' })
    const { json } = await run()
    expect(json.data.voices.tested).toBe('Aoife')
  })
  test('head coaches and staff are refused; the key is never in the answer', async () => {
    getCurrentUser.mockResolvedValue(userAt('head_coach'))
    expect((await run()).status).toBe(403)
    getCurrentUser.mockResolvedValue(userAt('owner'))
    synthesizeSpeech.mockResolvedValue({ ok: true, bytes: OGG, mime: 'audio/ogg' })
    expect(JSON.stringify((await run()).json)).not.toContain('el-key')
  })
})
