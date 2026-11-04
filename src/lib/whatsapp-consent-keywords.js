// The WhatsApp consent keywords (STOPWORDS.1), in a module with no imports so
// a pure file (src/lib/wa-voice/judge.js) can use them without pulling the
// server send stack. src/lib/whatsapp.js re-exports all three; the rule and
// its history live in the comment there.
export const CONSENT_STOP_KEYWORDS = Object.freeze(['unsubscribe', 'stop', 'stop all', 'stopall'])
export const CONSENT_START_KEYWORDS = Object.freeze(['start', 'unstop', 'subscribe'])

export function parseConsentKeyword(text) {
  const t = String(text || '').trim().toLowerCase()
  if (CONSENT_STOP_KEYWORDS.includes(t)) return 'stop'
  if (CONSENT_START_KEYWORDS.includes(t)) return 'start'
  return null
}
