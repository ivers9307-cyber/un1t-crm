import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { synthesizeSpeech, listVoices, ELEVENLABS_TTS_MODEL, ELEVENLABS_TTS_CENTS_PER_1K_CHARS } from './elevenlabs.js'

const audioRes = (status, bytes = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 1, 2])) => ({ ok: status >= 200 && status < 300, status, arrayBuffer: async () => bytes.buffer })
const jsonRes = (body) => ({ ok: true, status: 200, json: async () => body })

describe('synthesizeSpeech', () => {
  beforeEach(() => vi.stubEnv('ELEVENLABS_API_KEY', 'el-key'))
  afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers() })

  test('constants', () => {
    expect(ELEVENLABS_TTS_MODEL).toBe('eleven_v4_turbo')
    expect(ELEVENLABS_TTS_CENTS_PER_1K_CHARS).toBe(4)
  })
  test('no key → not_configured, no call', async () => {
    vi.stubEnv('ELEVENLABS_API_KEY', '')
    const fetchImpl = vi.fn()
    expect(await synthesizeSpeech({ text: 'hi', voiceId: 'v-1' }, { fetchImpl })).toEqual({ ok: false, reason: 'not_configured' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
  test('posts text and model to the voice, Opus by default', async () => {
    const fetchImpl = vi.fn(async () => audioRes(200))
    const r = await synthesizeSpeech({ text: 'See you at seven', voiceId: 'v-1' }, { fetchImpl })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://api.elevenlabs.io/v1/text-to-speech/v-1?output_format=opus_48000_64')
    expect(init.method).toBe('POST')
    expect(init.headers['xi-api-key']).toBe('el-key')
    expect(JSON.parse(init.body)).toEqual({ text: 'See you at seven', model_id: ELEVENLABS_TTS_MODEL })
    expect(r.ok).toBe(true)
    expect(r.bytes).toBeInstanceOf(Uint8Array)
    expect(r.mime).toBe('audio/ogg')
  })
  test('zero retention only when switched on, as for transcription (security review)', async () => {
    vi.stubEnv('ELEVENLABS_ZERO_RETENTION', 'true')
    const fetchImpl = vi.fn(async () => audioRes(200))
    await synthesizeSpeech({ text: 'x', voiceId: 'v-1' }, { fetchImpl })
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.elevenlabs.io/v1/text-to-speech/v-1?output_format=opus_48000_64&enable_logging=false')
  })
  test('mp3 for the browser sample', async () => {
    const fetchImpl = vi.fn(async () => audioRes(200))
    const r = await synthesizeSpeech({ text: 'x', voiceId: 'v/1', outputFormat: 'mp3_44100_64' }, { fetchImpl })
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.elevenlabs.io/v1/text-to-speech/v%2F1?output_format=mp3_44100_64')
    expect(r.mime).toBe('audio/mpeg')
  })
  test('failures', async () => {
    expect(await synthesizeSpeech({ text: 'x', voiceId: 'v' }, { fetchImpl: async () => audioRes(401) })).toEqual({ ok: false, reason: 'http_error', status: 401 })
    expect((await synthesizeSpeech({ text: 'x', voiceId: 'v' }, { fetchImpl: async () => audioRes(200, new Uint8Array(0)) })).reason).toBe('bad_response')
    expect((await synthesizeSpeech({ text: 'x', voiceId: 'v' }, { fetchImpl: async () => { throw new Error('reset') } })).reason).toBe('http_error')
    expect((await synthesizeSpeech({ text: '', voiceId: 'v' }, { fetchImpl: vi.fn() })).reason).toBe('bad_response')
  })
  test('a call that never answers times out at 15 s', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn((url, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    }))
    const settled = expect(synthesizeSpeech({ text: 'x', voiceId: 'v' }, { fetchImpl })).resolves.toEqual({ ok: false, reason: 'timeout' })
    await vi.advanceTimersByTimeAsync(15_000)
    await settled
  })
})

describe('listVoices', () => {
  beforeEach(() => vi.stubEnv('ELEVENLABS_API_KEY', 'el-key'))
  afterEach(() => vi.unstubAllEnvs())
  test('joins pages and keeps the picker fields', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonRes({ voices: [{ voice_id: 'a', name: 'Aoife', category: 'premade', labels: { accent: 'irish' }, extra: 1 }], has_more: true, next_page_token: 't2' }))
      .mockResolvedValueOnce(jsonRes({ voices: [{ voice_id: 'b', name: 'Brian', category: 'premade', labels: {} }], has_more: false, next_page_token: null }))
    const r = await listVoices({ fetchImpl })
    expect(r).toEqual({ ok: true, voices: [
      { voice_id: 'a', name: 'Aoife', category: 'premade', labels: { accent: 'irish' } },
      { voice_id: 'b', name: 'Brian', category: 'premade', labels: {} },
    ] })
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.elevenlabs.io/v2/voices?page_size=100')
    expect(fetchImpl.mock.calls[1][0]).toBe('https://api.elevenlabs.io/v2/voices?page_size=100&next_page_token=t2')
    expect(fetchImpl.mock.calls[0][1].headers['xi-api-key']).toBe('el-key')
  })
  test('no key, or an error', async () => {
    vi.stubEnv('ELEVENLABS_API_KEY', '')
    expect(await listVoices({ fetchImpl: vi.fn() })).toEqual({ ok: false, reason: 'not_configured' })
    vi.stubEnv('ELEVENLABS_API_KEY', 'k')
    expect((await listVoices({ fetchImpl: async () => ({ ok: false, status: 500 }) })).reason).toBe('http_error')
  })
})
