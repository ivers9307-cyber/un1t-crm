// TYPOHINT.1 — "did you mean …@gmail.com?" for an email typed into a form.
//
// A mistyped domain (gmial.com, hotmial.com) is a lead the gym can never
// reach, and some typo domains are run as spam traps, so mailing them hurts
// the sending domain (M3AAWG; Word to the Wise). This only SUGGESTS: the
// person taps the suggestion or ignores it, and nothing is ever changed or
// refused on their behalf.
//
// Pure, client-safe, no network. The list is the common consumer providers
// for an Irish audience; a domain not close to any of them gets no hint.

const KNOWN_DOMAINS = [
  'gmail.com', 'googlemail.com', 'hotmail.com', 'hotmail.co.uk', 'hotmail.ie', 'outlook.com', 'outlook.ie',
  'live.com', 'live.ie', 'icloud.com', 'me.com', 'yahoo.com', 'yahoo.ie', 'yahoo.co.uk', 'eircom.net', 'aol.com',
]

// Whole-domain typos that edit distance misses or ranks badly.
const DIRECT = {
  'gmail.co': 'gmail.com', 'gmail.ie': 'gmail.com', 'gmail.con': 'gmail.com', 'gmail.cm': 'gmail.com',
  'gmail.om': 'gmail.com', 'gmai.com': 'gmail.com', 'gamil.com': 'gmail.com', 'gnail.com': 'gmail.com',
  'hotmail.co': 'hotmail.com', 'hotmail.con': 'hotmail.com', 'hotmal.com': 'hotmail.com',
  'icloud.co': 'icloud.com', 'iclod.com': 'icloud.com', 'outlook.co': 'outlook.com', 'yahoo.co': 'yahoo.com',
}

function distance(a, b) {
  if (a === b) return 0
  const m = a.length
  const n = b.length
  if (Math.abs(m - n) > 2) return 3
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[n]
}

/**
 * The corrected address when the domain looks like a typo of a common
 * provider, else null. Never suggests for a domain that is already known.
 * @param {string} email
 * @returns {string|null}
 */
export function suggestEmailFix(email) {
  const raw = String(email || '').trim()
  const at = raw.lastIndexOf('@')
  if (at < 1 || at === raw.length - 1) return null
  const local = raw.slice(0, at)
  const domain = raw.slice(at + 1).toLowerCase()
  if (!domain.includes('.') || KNOWN_DOMAINS.includes(domain)) return null
  if (DIRECT[domain]) return `${local}@${DIRECT[domain]}`
  let best = null
  let bestD = 3
  for (const d of KNOWN_DOMAINS) {
    const dist = distance(domain, d)
    if (dist < bestD) { best = d; bestD = dist }
  }
  // One edit is a confident typo; two only for longer domains, where two
  // slips are still far from any real alternative.
  if (best && (bestD === 1 || (bestD === 2 && domain.length >= 9))) return `${local}@${best}`
  return null
}
