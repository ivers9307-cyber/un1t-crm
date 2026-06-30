// Validate that a raw user-entered phone is a plausible MOBILE number so the
// public funnels only capture WhatsApp/SMS-reachable leads. Irish-first (the
// audience), with UK + generic E.164 international accepted. Prefix rules
// mirror normalizePhone() in glofox-sync.js (08* = IE mobile, 07* = UK mobile).
//
// toMobileE164 returns the E.164 form when the input looks like a mobile, else
// null; isValidMobileNumber is the boolean gate used by forms + Zod refines.

const IE_MOBILE_NATIONAL = /^08\d{8}$/ // 08X + 7 digits = 10, national 0-trunk form
const IE_MOBILE_E164 = /^3538\d{8}$/ // +353 8X……, 12 digits
const UK_MOBILE_NATIONAL = /^07\d{9}$/ // 07 + 9 digits = 11
const UK_MOBILE_E164 = /^447\d{9}$/ // +44 7………, 12 digits

export function toMobileE164(raw) {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (!s) return null

  // An explicit international prefix (+ or 00) means the digits already carry a
  // country code; otherwise treat as a national number.
  let intl = false
  let digits
  if (s.startsWith('+')) { intl = true; digits = s.slice(1).replace(/\D/g, '') }
  else if (s.startsWith('00')) { intl = true; digits = s.slice(2).replace(/\D/g, '') }
  else { digits = s.replace(/\D/g, '') }
  if (!digits) return null

  // Country-coded forms (work whether or not a + was typed).
  if (IE_MOBILE_E164.test(digits)) return `+${digits}`
  if (UK_MOBILE_E164.test(digits)) return `+${digits}`

  if (!intl) {
    if (IE_MOBILE_NATIONAL.test(digits)) return `+353${digits.slice(1)}`
    if (UK_MOBILE_NATIONAL.test(digits)) return `+44${digits.slice(1)}`
    return null // bare national digits that aren't a recognised mobile
  }

  // Other countries: we can't tell mobile from fixed-line without a full
  // libphonenumber, so accept a well-formed E.164 (8–15 digits, not all the
  // same) and reject obvious junk.
  if (digits.length >= 8 && digits.length <= 15 && !/^(\d)\1+$/.test(digits)) return `+${digits}`
  return null
}

export function isValidMobileNumber(raw) {
  return toMobileE164(raw) != null
}
