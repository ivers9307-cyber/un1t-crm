// MAIL-REPLY-QUOTE.1 — where quoted text starts in a plain-text email body.
//
// One implementation for both apps (mobile cannot import src/lib; web reaches
// it through src/lib/mail-quote.js, a re-export asserted by runtime identity
// in tests/shared-pair-sync.test.js). Pure: no DOM, no clock, no fetch.
//
// The thread shows `body` and folds `quoted` behind "Show quoted text". The
// signature delimiter ("-- ") is NOT a split point: a signature is part of
// the message the person wrote.

const ATTRIBUTION_START = /^On\b/
const WROTE_END = /wrote:\s*$/
const QUOTE_LINE = /^>/
const FORWARD_SEPARATOR = /^-{5,}\s*Forwarded message\s*-{5,}\s*$/i
const ORIGINAL_MESSAGE = /^-{5,}\s*Original Message\s*-{5,}\s*$/i
const RULE_LINE = /^[_-]{10,}\s*$/
const FROM_LINE = /^From:/i

// The attribution may wrap onto a second or third line (Gmail breaks a long
// name+address before the address), so "wrote:" is accepted on this line or
// either of the next two.
function isAttribution(lines, i) {
  if (!ATTRIBUTION_START.test(lines[i])) return false
  for (let k = i; k < Math.min(i + 3, lines.length); k++) {
    if (WROTE_END.test(lines[k])) return true
  }
  return false
}

function isOutlookHeader(lines, i) {
  if (!RULE_LINE.test(lines[i])) return false
  for (let k = i + 1; k < Math.min(i + 3, lines.length); k++) {
    if (FROM_LINE.test(lines[k])) return true
  }
  return false
}

/**
 * @param {unknown} text
 * @returns {{ body: string, quoted: string }}
 */
export function splitQuotedText(text) {
  if (typeof text !== 'string') return { body: '', quoted: '' }
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let at = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (
      isAttribution(lines, i)
      || QUOTE_LINE.test(line)
      || FORWARD_SEPARATOR.test(line)
      || ORIGINAL_MESSAGE.test(line)
      || isOutlookHeader(lines, i)
    ) { at = i; break }
  }
  if (at < 0) return { body: lines.join('\n').replace(/\n+$/, ''), quoted: '' }
  return {
    body: lines.slice(0, at).join('\n').replace(/\n+$/, ''),
    quoted: lines.slice(at).join('\n').replace(/\n+$/, ''),
  }
}
