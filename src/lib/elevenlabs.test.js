import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { transcribeAudio, ELEVENLABS_STT_CENTS_PER_MINUTE } from './elevenlabs.js'

const bytes = new Uint8Array([1, 2, 3])
const okBody = { text: 'hi', language_code: 'en', language_probability: 0.9, words: [], audio_duration_secs: 2.1 }
const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

function stubFetch(response) {
  const calls = []
  const fetchImpl = vi.fn(async (url, init) => { calls.push({ url, init }); return typeof response === 'function' ? response() : response })
  return { fetchImpl, calls }
}

describe('transcribeAudio', () => {
  beforeEach(() => {
    vi.stubEnv('ELEVENLABS_API_KEY', 'el-test-key')
    vi.stubEnv('ELEVENLABS_ZERO_RETENTION', '')
  })
  afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers() })

  test('no key → not_configured and no call', async () => {
    vi.stubEnv('ELEVENLABS_API_KEY', '')
    const { fetchImpl } = stubFetch(jsonResponse(200, okBody))
    expect(await transcribeAudio({ bytes, mime: 'audio/ogg' }, { fetchImpl })).toEqual({ ok: false, reason: 'not_configured' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('posts scribe_v2 multipart with the key, auto language, no diarize, keyterms', async () => {
    const { fetchImpl, calls } = stubFetch(jsonResponse(200, okBody))
    await transcribeAudio({ bytes, mime: 'audio/ogg', keyterms: ['UN1T', 'HYROX'] }, { fetchImpl })
    const { url, init } = calls[0]
    expect(url).toBe('https://api.elevenlabs.io/v1/speech-to-text')
    expect(init.method).toBe('POST')
    expect(init.headers['xi-api-key']).toBe('el-test-key')
    const fd = init.body
    expect(fd.get('model_id')).toBe('scribe_v2')
    expect(fd.get('diarize')).toBe('false')
    expect(fd.get('tag_audio_events')).toBe('false')
    expect(fd.has('language_code')).toBe(false)
    expect(fd.getAll('keyterms')).toEqual(['UN1T', 'HYROX'])
    expect(fd.get('file')).toBeTruthy()
  })

  test('zero retention only when switched on', async () => {
    vi.stubEnv('ELEVENLABS_ZERO_RETENTION', 'true')
    const { fetchImpl, calls } = stubFetch(jsonResponse(200, okBody))
    await transcribeAudio({ bytes, mime: 'audio/ogg' }, { fetchImpl })
    expect(calls[0].url).toBe('https://api.elevenlabs.io/v1/speech-to-text?enable_logging=false')
  })

  test('a 500 is http_error', async () => {
    const { fetchImpl } = stubFetch(jsonResponse(500, { detail: 'x' }))
    expect(await transcribeAudio({ bytes, mime: 'audio/ogg' }, { fetchImpl })).toEqual({ ok: false, reason: 'http_error', status: 500 })
  })

  test('a call that never answers times out at 20 s', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn((url, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    }))
    const p = transcribeAudio({ bytes, mime: 'audio/ogg' }, { fetchImpl })
    const settled = expect(p).resolves.toEqual({ ok: false, reason: 'timeout' })
    await vi.advanceTimersByTimeAsync(20_000)
    await settled
  })

  test('a network error is http_error, never a throw', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNRESET') })
    expect(await transcribeAudio({ bytes, mime: 'audio/ogg' }, { fetchImpl })).toEqual({ ok: false, reason: 'http_error' })
  })

  test('a 200 maps to the result', async () => {
    const { fetchImpl } = stubFetch(jsonResponse(200, okBody))
    expect(await transcribeAudio({ bytes, mime: 'audio/ogg' }, { fetchImpl })).toEqual({
      ok: true, text: 'hi', languageCode: 'en', languageProbability: 0.9, durationSecs: 2.1, words: [],
    })
  })

  test('a 200 that is not JSON, or has no text, is bad_response', async () => {
    const { fetchImpl } = stubFetch({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad') } })
    expect((await transcribeAudio({ bytes, mime: 'audio/ogg' }, { fetchImpl })).reason).toBe('bad_response')
    const { fetchImpl: f2 } = stubFetch(jsonResponse(200, { language_code: 'en' }))
    expect((await transcribeAudio({ bytes, mime: 'audio/ogg' }, { fetchImpl: f2 })).reason).toBe('bad_response')
  })

  test('the cost is the Starter plan rate: Scribe v2 $0.22/h + keyterm prompting $0.05/h', () => {
    expect(ELEVENLABS_STT_CENTS_PER_MINUTE).toBeCloseTo((22 + 5) / 60, 10)
  })
})
