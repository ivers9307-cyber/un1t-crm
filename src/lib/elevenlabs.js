// VOICENOTE.1 — ElevenLabs Scribe speech-to-text, the transport only.
//
// One POST per voice note: multipart, model scribe_v2, language auto-detected,
// no diarisation, no audio-event tags. The key is the platform env var
// ELEVENLABS_API_KEY (transcription is a platform service metered per
// organisation, like the Anthropic key). Zero retention (`enable_logging=false`)
// is enterprise-only at ElevenLabs, so it is sent only when
// ELEVENLABS_ZERO_RETENTION=true: on any other plan it would refuse every call.
//
// Never throws and never retries: it runs inside the WhatsApp webhook, before
// Mia's turn, and a slow vendor must not hold the request (20 s cap).

export const ELEVENLABS_STT_URL = 'https://api.elevenlabs.io/v1/speech-to-text'
export const ELEVENLABS_STT_MODEL = 'scribe_v2'
export const ELEVENLABS_STT_TIMEOUT_MS = 20_000
// US cents per minute of audio, for operator visibility on usage_events only;
// ElevenLabs' invoice is the truth. The Starter plan (Richard, 4 Nov 2026):
// Scribe v2 $0.22 an hour plus keyterm prompting $0.05 an hour, and every call
// sends keyterms, so $0.27 an hour. The plan includes 27 hours a month, so the
// metered figure overstates the bill until those are used up.
export const ELEVENLABS_STT_CENTS_PER_MINUTE = (22 + 5) / 60

function extensionFor(mime) {
  const m = String(mime || '').toLowerCase()
  if (m.includes('ogg') || m.includes('opus')) return 'ogg'
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3'
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'm4a'
  if (m.includes('amr')) return 'amr'
  if (m.includes('wav')) return 'wav'
  return 'bin'
}

/**
 * @param {{ bytes: Uint8Array, mime?: string, keyterms?: string[] }} input
 * @param {{ fetchImpl?: typeof fetch }} [deps]
 * @returns {Promise<{ ok: true, text: string, languageCode: string|null, languageProbability: number|null, durationSecs: number|null, words: object[] }
 *                 | { ok: false, reason: 'not_configured'|'http_error'|'timeout'|'bad_response', status?: number }>}
 */
export async function transcribeAudio({ bytes, mime, keyterms = [] } = {}, { fetchImpl = fetch } = {}) {
  const key = process.env.ELEVENLABS_API_KEY
  if (!key) return { ok: false, reason: 'not_configured' }

  const url = process.env.ELEVENLABS_ZERO_RETENTION === 'true'
    ? `${ELEVENLABS_STT_URL}?enable_logging=false`
    : ELEVENLABS_STT_URL

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ELEVENLABS_STT_TIMEOUT_MS)
  try {
    const form = new FormData()
    form.append('model_id', ELEVENLABS_STT_MODEL)
    form.append('diarize', 'false')
    form.append('tag_audio_events', 'false')
    for (const term of Array.isArray(keyterms) ? keyterms : []) form.append('keyterms', term)
    const type = mime || 'application/octet-stream'
    form.append('file', new Blob([bytes], { type }), `voice-note.${extensionFor(type)}`)

    let res
    try {
      res = await fetchImpl(url, { method: 'POST', headers: { 'xi-api-key': key }, body: form, signal: controller.signal })
    } catch (err) {
      if (controller.signal.aborted || err?.name === 'AbortError') return { ok: false, reason: 'timeout' }
      return { ok: false, reason: 'http_error' }
    }
    if (!res?.ok) return { ok: false, reason: 'http_error', status: res?.status }

    let body
    try {
      body = await res.json()
    } catch {
      if (controller.signal.aborted) return { ok: false, reason: 'timeout' }
      return { ok: false, reason: 'bad_response' }
    }
    if (!body || typeof body.text !== 'string') return { ok: false, reason: 'bad_response' }
    return {
      ok: true,
      text: body.text,
      languageCode: typeof body.language_code === 'string' ? body.language_code : null,
      languageProbability: typeof body.language_probability === 'number' ? body.language_probability : null,
      durationSecs: typeof body.audio_duration_secs === 'number' && body.audio_duration_secs >= 0 ? body.audio_duration_secs : null,
      words: Array.isArray(body.words) ? body.words : [],
    }
  } catch {
    return { ok: false, reason: 'bad_response' }
  } finally {
    clearTimeout(timer)
  }
}

// ── VOICEREPLY.1 — text to speech, for Mia's voice replies ──────────────────
// Opus at 48 kHz by default: WhatsApp renders a voice note only for Ogg/Opus
// (the caller checks the bytes really are Ogg: src/lib/wa-voice/reply-rules.js
// isOggOpus). mp3 is for the settings card's in-browser sample.
// scripts/elevenlabs-tts-probe.mjs is the live check of both facts the docs
// leave open: the Opus container, and whether this model is accepted here.
export const ELEVENLABS_TTS_BASE_URL = 'https://api.elevenlabs.io/v1/text-to-speech'
export const ELEVENLABS_VOICES_URL = 'https://api.elevenlabs.io/v2/voices'
export const ELEVENLABS_TTS_MODEL = 'eleven_v4_turbo'
export const ELEVENLABS_TTS_TIMEOUT_MS = 15_000
// US cents per 1,000 characters: v4 Turbo, $0.04 (Richard's price sheet,
// 4 Nov 2026). An estimate for usage_events; ElevenLabs' invoice is the truth.
export const ELEVENLABS_TTS_CENTS_PER_1K_CHARS = 4

const MAX_VOICE_PAGES = 10

function mimeForFormat(format) {
  if (String(format).startsWith('opus')) return 'audio/ogg'
  if (String(format).startsWith('mp3')) return 'audio/mpeg'
  return 'application/octet-stream'
}

/**
 * @param {{ text: string, voiceId: string, outputFormat?: string }} input
 * @param {{ fetchImpl?: typeof fetch }} [deps]
 * @returns {Promise<{ ok: true, bytes: Uint8Array, mime: string } | { ok: false, reason: 'not_configured'|'http_error'|'timeout'|'bad_response', status?: number }>}
 */
export async function synthesizeSpeech({ text, voiceId, outputFormat = 'opus_48000_64' } = {}, { fetchImpl = fetch } = {}) {
  const key = process.env.ELEVENLABS_API_KEY
  if (!key) return { ok: false, reason: 'not_configured' }
  if (!String(text || '').trim() || !String(voiceId || '').trim()) return { ok: false, reason: 'bad_response' }
  // Same retention control as transcribeAudio: enterprise-only zero retention.
  const retention = process.env.ELEVENLABS_ZERO_RETENTION === 'true' ? '&enable_logging=false' : ''
  const url = `${ELEVENLABS_TTS_BASE_URL}/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(outputFormat)}${retention}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ELEVENLABS_TTS_TIMEOUT_MS)
  try {
    let res
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: mimeForFormat(outputFormat) },
        body: JSON.stringify({ text: String(text), model_id: ELEVENLABS_TTS_MODEL }),
        signal: controller.signal,
      })
    } catch (err) {
      if (controller.signal.aborted || err?.name === 'AbortError') return { ok: false, reason: 'timeout' }
      return { ok: false, reason: 'http_error' }
    }
    if (!res?.ok) return { ok: false, reason: 'http_error', status: res?.status }
    let bytes
    try {
      bytes = new Uint8Array(await res.arrayBuffer())
    } catch {
      if (controller.signal.aborted) return { ok: false, reason: 'timeout' }
      return { ok: false, reason: 'bad_response' }
    }
    if (!bytes.length) return { ok: false, reason: 'bad_response' }
    return { ok: true, bytes, mime: mimeForFormat(outputFormat) }
  } catch {
    return { ok: false, reason: 'bad_response' }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The voices the account can use, for the settings picker. Never throws.
 * @returns {Promise<{ ok: true, voices: Array<{ voice_id: string, name: string, category: string|null, labels: object }> } | { ok: false, reason: string, status?: number }>}
 */
export async function listVoices({ fetchImpl = fetch } = {}) {
  const key = process.env.ELEVENLABS_API_KEY
  if (!key) return { ok: false, reason: 'not_configured' }
  const voices = []
  let token = null
  try {
    for (let page = 0; page < MAX_VOICE_PAGES; page++) {
      const url = `${ELEVENLABS_VOICES_URL}?page_size=100${token ? `&next_page_token=${encodeURIComponent(token)}` : ''}`
      const res = await fetchImpl(url, { headers: { 'xi-api-key': key } })
      if (!res?.ok) return { ok: false, reason: 'http_error', status: res?.status }
      const body = await res.json()
      for (const v of Array.isArray(body?.voices) ? body.voices : []) {
        if (!v?.voice_id) continue
        voices.push({ voice_id: v.voice_id, name: v.name || v.voice_id, category: v.category ?? null, labels: v.labels || {} })
      }
      if (!body?.has_more || !body?.next_page_token) break
      token = body.next_page_token
    }
    return { ok: true, voices }
  } catch {
    return { ok: false, reason: 'bad_response' }
  }
}
