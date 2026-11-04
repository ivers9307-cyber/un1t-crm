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
