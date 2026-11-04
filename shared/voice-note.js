// VOICENOTE.1 — how a WhatsApp voice note's transcript is read and shown.
//
// Pure, shared by the web inbox (`@shared/voice-note`), the phone
// (`shared/voice-note`) and Mia's history formatter (src/lib/agent/core.js).
// The statuses are the CHECK list on whatsapp_messages.transcript_status
// (mig 808): change both together (tests/voice-note-migration.test.js).

export const TRANSCRIPT_STATUSES = Object.freeze([
  'pending',
  'ok',
  'unclear',
  'too_long',
  'capped',
  'disabled',
  'not_configured',
  'failed',
])

// The prefix Mia sees before a transcribed voice note in her history.
export const VOICE_TRANSCRIPT_MARKER = '(voice note transcript) '

// A row still `pending` this long after it arrived was never finished (a crash
// after the insert, then a Meta retry the dedupe skipped). It reads as failed.
export const PENDING_STALE_MS = 600_000

export function effectiveTranscriptStatus(row, nowMs = Date.now()) {
  const status = row?.transcript_status ?? null
  if (status !== 'pending') return status
  const created = Date.parse(row?.created_at ?? '')
  if (Number.isFinite(created) && nowMs - created > PENDING_STALE_MS) return 'failed'
  return 'pending'
}

const LANGUAGE_NAMES = {
  pt: 'Portuguese', por: 'Portuguese',
  es: 'Spanish', spa: 'Spanish',
  pl: 'Polish', pol: 'Polish',
  ga: 'Irish', gle: 'Irish',
  fr: 'French', fra: 'French',
  it: 'Italian', ita: 'Italian',
  de: 'German', deu: 'German',
  ro: 'Romanian', ron: 'Romanian',
  lt: 'Lithuanian', lit: 'Lithuanian',
}

function languageName(code) {
  if (!code || typeof code !== 'string') return null
  const c = code.trim().toLowerCase()
  if (!c || c === 'en' || c === 'eng') return null
  return LANGUAGE_NAMES[c] || c.toUpperCase()
}

const NOTES = {
  unclear: "Couldn't make it out clearly:",
  too_long: 'Over 3 minutes, not transcribed',
  capped: 'Monthly transcription limit reached',
  failed: 'Transcription unavailable',
  not_configured: 'Transcription unavailable',
  pending: 'Transcribing…',
}

// What staff see under a voice note: null for anything that is not an audio
// row with a status (pre-launch audio, `disabled`), else the transcript (when
// there is one to show), a one-line note, and the language when not English.
export function voiceNoteCaption(msg, nowMs = Date.now()) {
  if (!msg || msg.message_type !== 'audio') return null
  const status = effectiveTranscriptStatus(msg, nowMs)
  if (!status || status === 'disabled') return null
  const text = typeof msg.transcript === 'string' && msg.transcript.trim() ? msg.transcript.trim() : null
  if (status === 'ok') {
    if (!text) return null
    return { transcript: text, note: null, language: languageName(msg.transcript_language) }
  }
  if (status === 'unclear') {
    return { transcript: text, note: NOTES.unclear, language: null }
  }
  const note = NOTES[status]
  if (!note) return null
  return { transcript: null, note, language: null }
}

// A realtime UPDATE on whatsapp_messages that is a voice note's transcript
// landing (not a delivery or read receipt): the web inbox refreshes the open
// thread only for these.
export function isVoiceTranscriptUpdate(row) {
  return !!row && row.message_type === 'audio' && !!row.transcript_status && row.transcript_status !== 'pending'
}

// VOICEREPLY.1 — the kinds of Mia reply that can each have their own voice
// (whatsapp_messages.voice_kind CHECK, mig 809: change both together;
// tests/voice-reply-migration.test.js).
export const VOICE_KINDS = Object.freeze(['lead', 'booking', 'member', 'handoff', 'default'])

export const VOICE_KIND_LABELS = Object.freeze({
  lead: 'Leads and trials',
  booking: 'Bookings',
  member: 'Member questions',
  handoff: 'Hand-off message',
  default: 'Default',
})

// What staff see under one of Mia's voice replies.
export function voiceReplyLabel(msg) {
  if (!msg || msg.direction !== 'outbound' || msg.message_type !== 'audio') return null
  const label = VOICE_KIND_LABELS[msg.voice_kind]
  return label ? `Mia replied by voice · ${label}` : null
}
