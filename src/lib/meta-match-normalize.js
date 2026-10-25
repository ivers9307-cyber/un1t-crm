// meta-match-normalize — Meta's match-key normalisation, shared by the server
// (meta-capi.js hashes these before sending) and the browser (the Pixel's
// manual advanced matching takes the normalised raw value and hashes it
// itself). No node imports, so a client component may import it.

export function normalizeEmailForMeta(email) {
  const e = String(email || '').trim().toLowerCase()
  return e.includes('@') ? e : null
}

/**
 * Digits only with country code — Irish national format (08x…) becomes
 * 3538x…, international 00-prefixes are stripped. Null when too short.
 */
export function normalizePhoneForMeta(phone) {
  let d = String(phone || '').replace(/\D/g, '')
  if (d.startsWith('00')) d = d.slice(2)
  else if (d.startsWith('0')) d = `353${d.slice(1)}`
  return d.length >= 8 ? d : null
}

/**
 * MATCHQUALITY.1 — lower-case, trimmed, punctuation and digits removed
 * (letters, marks and spaces survive). Null when nothing is left.
 */
export function normalizeNameForMeta(name) {
  const n = String(name || '').toLowerCase().replace(/[^\p{L}\p{M}\s]/gu, '').replace(/\s+/g, ' ').trim()
  return n || null
}
