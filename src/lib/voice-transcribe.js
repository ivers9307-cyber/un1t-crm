// AGENT-VOICE.1 — transcribe inbound WhatsApp voice notes so the
// customer agent can answer them instead of soft-handing-off, and so
// the inbox shows what was said. Provider: OpenAI whisper-1 (the
// industry default for short voice notes, ~$0.006/min) behind
// OPENAI_API_KEY — when the key is absent everything degrades to the
// previous behaviour (soft handoff, '[audio]' preview). Never throws.

const OPENAI_TRANSCRIPTION_URL = 'https://api.openai.com/v1/audio/transcriptions'
const MAX_BODY_LEN = 2000
// Whisper caps uploads at 25MB; WhatsApp voice notes are ~3KB/sec
// opus, so anything bigger than this isn't a voice note.
const MAX_AUDIO_BYTES = 16 * 1024 * 1024

/** The message body recorded for a transcribed voice note. Pure. */
export function voiceBodyFromTranscript(transcript) {
  const t = String(transcript || '').trim()
  if (!t) return null
  return `🎙️ ${t}`.slice(0, MAX_BODY_LEN)
}

/**
 * Fetch the voice note from Meta and transcribe it.
 * @returns {Promise<string|null>} the raw transcript, or null
 */
export async function transcribeWhatsAppAudio({ mediaId, locationId, mime } = {}) {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey || !mediaId) return null
  try {
    const { fetchMediaBytes } = await import('@/lib/whatsapp')
    const media = await fetchMediaBytes(mediaId, { locationId })
    if (!media?.bytes || media.bytes.byteLength === 0 || media.bytes.byteLength > MAX_AUDIO_BYTES) return null

    const form = new FormData()
    const type = media.mime || mime || 'audio/ogg'
    const ext = /mp4|m4a/.test(type) ? 'm4a' : /mpeg|mp3/.test(type) ? 'mp3' : 'ogg'
    form.append('file', new Blob([media.bytes], { type }), `voice-note.${ext}`)
    form.append('model', 'whisper-1')

    const res = await fetch(OPENAI_TRANSCRIPTION_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    })
    if (!res.ok) {
      console.warn(`[voice-transcribe] whisper http ${res.status}`)
      return null
    }
    const body = await res.json()
    const text = String(body?.text || '').trim()
    return text || null
  } catch (e) {
    console.warn('[voice-transcribe] failed:', e?.message || e)
    return null
  }
}
