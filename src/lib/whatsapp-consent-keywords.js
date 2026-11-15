// The WhatsApp consent keywords (STOPWORDS.1), in a module with no imports so
// a pure file (src/lib/wa-voice/judge.js) can use them without pulling the
// server send stack. src/lib/whatsapp.js re-exports all three; the rule and
// its history live in the comment there.
export const CONSENT_STOP_KEYWORDS = Object.freeze(['unsubscribe', 'stop', 'stop all', 'stopall'])
export const CONSENT_START_KEYWORDS = Object.freeze(['start', 'unstop', 'subscribe'])

// WASTOP.1 (audit 2026-11-15, item 7): leading and trailing punctuation,
// emoji and whitespace are ignored, so "Stop.", "STOP!" and "stop 🙏" are the
// keyword; inner spacing collapses, so "stop  all" is STOP ALL. The words
// themselves are unchanged (STOPWORDS.1), and anything else in the message
// ("stop please", "stop the classes") is still an ordinary message: a reply
// that is more than the keyword may mean something else, and Mia or staff
// read it. Same edge-stripping wa-voice/judge.js already applies.
export function normaliseConsentText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '')
    .replace(/\s+/g, ' ')
}

export function parseConsentKeyword(text) {
  const t = normaliseConsentText(text)
  if (CONSENT_STOP_KEYWORDS.includes(t)) return 'stop'
  if (CONSENT_START_KEYWORDS.includes(t)) return 'start'
  return null
}

/**
 * The text a consent keyword is read from, for every message type a person
 * can opt out with: typed text, a template quick-reply tap (type 'button':
 * its visible text, else its payload), or a session button / list tap (type
 * 'interactive': its title). Before WASTOP.1 only 'text' was read, so a tapped
 * "Stop" button reached Mia and nobody was unsubscribed. Pure.
 * @param {object} message one entry of Meta's messages[]
 * @returns {string|null} null for a type no keyword can arrive in
 */
export function consentTextOf(message) {
  switch (message?.type || 'text') {
    case 'text':
      return message.text?.body ?? ''
    case 'button':
      return message.button?.text || message.button?.payload || ''
    case 'interactive': {
      const reply = message.interactive?.button_reply || message.interactive?.list_reply
      return reply?.title || ''
    }
    default:
      return null
  }
}
