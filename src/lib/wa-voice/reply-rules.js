// VOICEREPLY.1 — the rules for Mia's voice replies: what is spoken, what
// follows as text, which kind of reply it is and which voice says it. Pure.
// Design: docs/superpowers/specs/2026-11-04-wa-voice-replies-design.md §3, §5.

import { splitTrailingUrl } from '@/lib/whatsapp'

// About 45 seconds of speech (Richard, 4 Nov 2026). Longer goes as text.
export const MAX_SPOKEN_CHARS = 600

// Added to the volatile (uncached) prompt suffix on a voice-note turn only.
export const VOICE_REPLY_PROMPT_LINE = '## This reply will be spoken\nThe customer sent a voice note, so your reply will be sent as a voice note. Write it as you would say it: short and conversational, no emoji, no lists or bullet points, no bold, and spell times the way you would say them. A booking link or buttons are still fine: they are sent as text after the voice note.'

const URL_RE = /https?:\/\/\S+/g
const EMOJI_RE = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}️‍]/gu
const BULLET_RE = /^\s*[•\-*]\s+/gm
const MARKUP_RE = /[*_~`]/g

// The text to speak: emoji, markup, bullet markers and URLs removed, blank
// lines collapsed. It never adds or changes a word.
export function spokenTextFor(text) {
  return String(text || '')
    .replace(URL_RE, '')
    .replace(EMOJI_RE, '')
    .replace(BULLET_RE, '')
    .replace(MARKUP_RE, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').replace(/\s+([,.!?;:])/g, '$1').trim())
    .filter(Boolean)
    .join('\n')
}

// What is spoken, and what follows the voice note as text.
export function splitForVoice({ text, options } = {}) {
  const t = String(text || '')
  const opts = Array.isArray(options) && options.length >= 2 ? options : null
  if (opts) return { spoken: spokenTextFor(t), followUp: { kind: 'options', options: opts } }
  const trailing = splitTrailingUrl(t)
  if (trailing) return { spoken: spokenTextFor(trailing.body), followUp: { kind: 'cta_url', body: trailing.body, url: trailing.url } }
  if (/https?:\/\//.test(t)) return { spoken: spokenTextFor(t), followUp: { kind: 'text', text: t } }
  return { spoken: spokenTextFor(t), followUp: null }
}

// What she did wins (Richard, 4 Nov 2026): a hand-off, then a booking change,
// then who the customer is.
export function voiceKindFor({ isHandoff = false, bookingToolSucceeded = false, isMember = false } = {}) {
  if (isHandoff) return 'handoff'
  if (bookingToolSucceeded) return 'booking'
  if (isMember) return 'member'
  return 'lead'
}

const hasVoice = (v) => !!(v && typeof v.voice_id === 'string' && v.voice_id.trim())

export function voiceFor(kind, voices) {
  if (!voices || typeof voices !== 'object') return null
  if (hasVoice(voices[kind])) return voices[kind]
  if (hasVoice(voices.default)) return voices.default
  return null
}

// WhatsApp renders a voice note only for Ogg/Opus.
export function isOggOpus(bytes) {
  return bytes instanceof Uint8Array && bytes.length >= 4
    && bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53
}

const SUCCESS_FIELD = {
  book_class: 'booked',
  book_consultation: 'booked',
  book_event: 'booked',
  cancel_class_booking: 'cancelled',
  cancel_event_registration: 'cancelled',
  move_class_booking: 'moved',
  move_event_entry: 'moved',
}

// Did this tool call book, cancel or move something?
export function toolResultSucceeded(name, result) {
  const field = SUCCESS_FIELD[name]
  return !!field && !!result && typeof result === 'object' && result[field] === true
}

// Is the newest inbound Mia is answering a voice note? Rows ascending by time.
export function isVoiceTrigger({ historyRows } = {}) {
  const rows = Array.isArray(historyRows) ? historyRows : []
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i]?.direction === 'inbound') return rows[i].message_type === 'audio'
  }
  return false
}
