import { describe, test, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/elevenlabs', async (importOriginal) => ({ ...(await importOriginal()), listVoices: vi.fn(), synthesizeSpeech: vi.fn() }))
vi.mock('@/lib/usage', () => ({ recordMeterUsage: vi.fn(async () => {}) }))

import { GET, PUT } from './route'
import { POST as SAMPLE } from './sample/route'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { listVoices, synthesizeSpeech } from '@/lib/elevenlabs'
import { recordMeterUsage } from '@/lib/usage'

const userAt = (role, loc = 'loc-1') => ({ id: 'u-1', profileRole: role === 'master' ? 'master' : 'staff', role, activeLocation: { id: loc }, locations: [{ id: loc }], rolesByLocation: { [loc]: role } })
const AVAILABLE = [{ voice_id: 'v1', name: 'Aoife', category: 'premade', labels: {} }, { voice_id: 'v2', name: 'Brian', category: 'premade', labels: {} }]

let updates, settings
beforeEach(() => {
  vi.clearAllMocks()
  updates = []
  settings = { customer_agent: { enabled: true }, voice_replies: { voices: { lead: { voice_id: 'v1', name: 'Aoife' } } } }
  listVoices.mockResolvedValue({ ok: true, voices: AVAILABLE })
  createServerClient.mockReturnValue({
    from: () => {
      const b = {
        select: () => b, eq: () => b,
        maybeSingle: async () => ({ data: { id: 'loc-1', organization_id: 'org-1', settings }, error: null }),
        single: async () => ({ data: { id: 'loc-1', organization_id: 'org-1', settings }, error: null }),
        update: (patch) => { updates.push(patch); return b },
      }
      return b
    },
  })
})
const put = (body) => PUT(new Request('http://x/api/settings/voice-replies', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
const sample = (body) => SAMPLE(new Request('http://x/api/settings/voice-replies/sample', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))

describe('/api/settings/voice-replies', () => {
  test('owners, managers and masters at the studio; head coaches and staff refused', async () => {
    for (const role of ['owner', 'manager', 'master']) {
      getCurrentUser.mockResolvedValue(userAt(role))
      expect((await GET()).status).toBe(200)
    }
    for (const role of ['head_coach', 'staff']) {
      getCurrentUser.mockResolvedValue(userAt(role))
      expect((await GET()).status).toBe(403)
      expect((await put({ voices: {} })).status).toBe(403)
    }
  })
  test('GET returns the studio voices and the voices the account can use', async () => {
    getCurrentUser.mockResolvedValue(userAt('manager'))
    const json = await (await GET()).json()
    expect(json.data).toEqual({ voices: { lead: { voice_id: 'v1', name: 'Aoife' } }, ai_notice: null, buttons_line: null, available: AVAILABLE })
  })
  test('PUT stores only voice_replies, keeps every other settings key', async () => {
    getCurrentUser.mockResolvedValue(userAt('manager'))
    const res = await put({ voices: { booking: { voice_id: 'v2', name: 'Brian' }, lead: null }, ai_notice: '', buttons_line: 'Pick one:' })
    expect(res.status).toBe(200)
    expect(updates[0].settings).toEqual({
      customer_agent: { enabled: true },
      voice_replies: { voices: { booking: { voice_id: 'v2', name: 'Brian' }, lead: null }, ai_notice: null, buttons_line: 'Pick one:' },
    })
  })
  test('an unknown voice, an unknown kind or a long notice is refused', async () => {
    getCurrentUser.mockResolvedValue(userAt('owner'))
    expect((await put({ voices: { booking: { voice_id: 'nope', name: 'X' } } })).status).toBe(400)
    expect((await put({ voices: { shouting: { voice_id: 'v1', name: 'A' } } })).status).toBe(400)
    expect((await put({ voices: {}, ai_notice: 'x'.repeat(301) })).status).toBe(400)
    expect(updates).toHaveLength(0)
  })
  test('the ElevenLabs voice list unreadable → 502, nothing stored', async () => {
    getCurrentUser.mockResolvedValue(userAt('owner'))
    listVoices.mockResolvedValue({ ok: false, reason: 'http_error' })
    expect((await put({ voices: { booking: { voice_id: 'v1', name: 'A' } } })).status).toBe(502)
    expect(updates).toHaveLength(0)
  })
  test('signed out → 401', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await GET()).status).toBe(401)
  })
})

describe('/api/settings/voice-replies/sample', () => {
  test('plays a known voice as mp3 and meters it', async () => {
    getCurrentUser.mockResolvedValue(userAt('manager'))
    synthesizeSpeech.mockResolvedValue({ ok: true, bytes: new Uint8Array([1, 2, 3]), mime: 'audio/mpeg' })
    const res = await sample({ voice_id: 'v2' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('audio/mpeg')
    expect(synthesizeSpeech).toHaveBeenCalledWith({ text: "Hi, it's Mia from UN1T. Your class is booked for seven tomorrow morning.", voiceId: 'v2', outputFormat: 'mp3_44100_64' })
    expect(recordMeterUsage.mock.calls.map(([e]) => e.meter)).toEqual(['elevenlabs_tts_characters', 'elevenlabs_tts_replies'])
  })
  test('an ElevenLabs failure → 502; an unknown voice → 400; staff → 403', async () => {
    getCurrentUser.mockResolvedValue(userAt('owner'))
    synthesizeSpeech.mockResolvedValue({ ok: false, reason: 'http_error' })
    const r = await sample({ voice_id: 'v1' })
    expect(r.status).toBe(502)
    expect((await r.json()).success).toBe(false)
    expect((await sample({ voice_id: 'nope' })).status).toBe(400)
    getCurrentUser.mockResolvedValue(userAt('staff'))
    expect((await sample({ voice_id: 'v1' })).status).toBe(403)
  })
})
