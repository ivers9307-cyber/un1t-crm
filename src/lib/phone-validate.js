// Validate that a raw user-entered phone is a plausible MOBILE number so the
// public funnels only capture WhatsApp/SMS-reachable leads. Irish-first (the
// audience), with UK + generic E.164 international accepted. Prefix rules
// mirror normalizePhone() in glofox-sync.js (08* = IE mobile, 07* = UK mobile),
// plus the bare no-country-code Irish mobile that toE164Ireland() below
// accepts — see IE_MOBILE_BARE. normalizePhone() still passes that shape through
// unchanged; it is a sync-side normaliser, not a gate, so it is left alone here.
//
// toMobileE164 returns the E.164 form when the input looks like a mobile, else
// null; isValidMobileNumber is the boolean gate used by forms + Zod refines.

const IE_MOBILE_NATIONAL = /^08\d{8}$/ // 08X + 7 digits = 10, national 0-trunk form
// Same mobile with the trunk zero already dropped and no country code — the
// shape an Irish number takes once it's been prepared for a +353 prefix. 431
// contacts hold exactly this form (all five active prefixes; every one of them
// has a correct +3538… wa_phone and 93 have live WhatsApp threads), so it is a
// real, reachable representation people also type. Deliberately NARROWER than
// the 08* used above: bare 81… would swallow 0818 lo-call, which is not a
// mobile. 83/85/86/87/89 are active; 84/88 are headroom.
const IE_MOBILE_BARE = /^8[3-9]\d{7}$/ // 8X + 7 digits = 9, no trunk zero, no CC
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

  // A country code is never followed by the national trunk zero — E.164 drops
  // it. Repair the double prefix before the mobile tests, otherwise
  // +3530871234567 fails IE_MOBILE_E164 and the generic international branch
  // below waves it through as a valid foreign number, storing an unusable
  // string. 106 rows in `contacts` carry the +353 form and 2 the +44 form (one
  // of them a member). Unambiguous in both cases: 44 and 353 are the only
  // country codes those digits can start with, and neither has a national
  // number beginning 0.
  if (digits.startsWith('3530')) digits = `353${digits.slice(4)}`
  if (digits.startsWith('440')) digits = `44${digits.slice(3)}`

  // Country-coded forms (work whether or not a + was typed).
  if (IE_MOBILE_E164.test(digits)) return `+${digits}`
  if (UK_MOBILE_E164.test(digits)) return `+${digits}`

  if (!intl) {
    if (IE_MOBILE_NATIONAL.test(digits)) return `+353${digits.slice(1)}`
    if (UK_MOBILE_NATIONAL.test(digits)) return `+44${digits.slice(1)}`
    // No trunk zero to strip — the country code is simply absent. toE164Ireland()
    // below already accepts this shape; this gate was the strictest of the three
    // normalisers and the only public-facing one.
    if (IE_MOBILE_BARE.test(digits)) return `+353${digits}`
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

/**
 * Normalise an Irish phone number to E.164 (+353…). Best-effort —
 * if the input doesn't look like an Irish number, returns the cleaned
 * digits unchanged so the downstream sender gets a chance to reject
 * explicitly. Unlike toMobileE164 this is not a mobile gate.
 * (Moved here from the retired twilio.js.) NOT for WhatsApp: it passes a
 * landline or a bare 9-digit non-mobile through as '+353…', which the two
 * WhatsApp automations then sent to and stored as wa_phone. Since WAPHONE.1
 * they use waPhoneFromPhone / contactWhatsAppNumber below instead.
 *
 *   '0871234567'    → '+353871234567'
 *   '+353871234567' → '+353871234567'  (unchanged)
 *   '353871234567'  → '+353871234567'
 *   '871234567'     → '+353871234567'
 *
 * @param {string} raw
 * @returns {string}
 */
export function toE164Ireland(raw) {
  if (!raw) return raw
  const digits = String(raw).replace(/[^\d+]/g, '')
  if (digits.startsWith('+')) return digits
  if (digits.startsWith('00')) return '+' + digits.slice(2)
  if (digits.startsWith('353')) return '+' + digits
  if (digits.startsWith('0')) return '+353' + digits.slice(1)
  // Bare mobile prefix without leading 0 (e.g. just '87…' or '85…')
  if (/^[1-9]\d{7,8}$/.test(digits)) return '+353' + digits
  return digits
}

// ── WAPHONE.1 — the ONE phone → WhatsApp-number rule ─────────────────────────
//
// contacts.wa_phone is what every WhatsApp sender reads (broadcasts, sequences,
// Mia, the inbox), and the trigger that derives it from `phone`
// (public.derive_wa_phone → public.normalize_wa_phone, mig 753) runs on every
// contacts INSERT and every UPDATE that names `phone`, so no write path can
// skip it. waPhoneFromPhone is the same rule in JS, statement for statement;
// tests/wa-phone-normaliser-parity.test.js runs the SQL (PGlite) and this
// function over one fixture table and fails on any disagreement. Change both
// in the same PR, or neither.
//
// Output: E.164 DIGITS, no '+' (the form wa_phone, the webhook and Meta's
// wa_id use), or null when the number cannot be trusted as a WhatsApp number.
//
//   * Irish mobiles in any spelling: 08X…, 8X… (no trunk zero), 3538X…,
//     +353 8X…, 00353 8X…, with spaces, dashes or brackets. X = 3-9.
//   * UK mobiles: 07… (11 digits, unambiguous: no Irish number is 07 + 9),
//     447…, +44 7….
//   * A country code followed by the national trunk zero is repaired
//     (+353 087… → 35387…, +44 07… → 447…): neither country has a national
//     number starting 0, and 95 live contacts carried 35308… with no '+'.
//   * ANY other number written with an international prefix ('+' or '00')
//     is trusted as international: 8-15 digits, country code not 0, not one
//     repeated digit, and a +1 number must be a real NANP shape (which also
//     rejects the ClassPass '+10000000000' placeholder).
//   * Rejected: Irish and UK landlines/lo-call (353 or 44 not followed by a
//     mobile prefix of the right length; WhatsApp is mobile in practice and
//     the gates before this rejected them too), anything containing letters
//     (an email typed into the phone field), and BARE foreign digits with no
//     '+'/'00': '(317) 427-8753' stored as 3174278753 would read as a Dutch
//     +31 number and reach a stranger (mig 525). Staff fix those by adding
//     the '+'.
const WA_IE_MOBILE = /^3538[3-9][0-9]{7}$/
const WA_UK_MOBILE = /^447[0-9]{9}$/
const WA_NANP = /^1[2-9][0-9]{2}[2-9][0-9]{6}$/

/**
 * @param {unknown} raw  a phone as typed or synced
 * @returns {string|null} E.164 digits without '+', or null
 */
export function waPhoneFromPhone(raw) {
  if (raw == null) return null
  const s = String(raw)
  if (!/[0-9]/.test(s)) return null
  if (/[A-Za-z]/.test(s)) return null
  let d = s.replace(/[^0-9]/g, '')
  // International when the first digit-or-plus is '+', or the digits open 00.
  const firstMark = s.match(/[0-9+]/)
  const intl = (firstMark && firstMark[0] === '+') || d.startsWith('00')
  if (d.startsWith('00')) d = d.slice(2)
  if (d.startsWith('3530')) d = `353${d.slice(4)}`
  else if (d.startsWith('440')) d = `44${d.slice(3)}`
  if (!intl) {
    if (/^08[3-9][0-9]{7}$/.test(d)) d = `353${d.slice(1)}`
    else if (/^8[3-9][0-9]{7}$/.test(d)) d = `353${d}`
    else if (/^07[0-9]{9}$/.test(d)) d = `44${d.slice(1)}`
  }
  if (d === '') return null
  if (WA_IE_MOBILE.test(d) || WA_UK_MOBILE.test(d)) return d
  if (d.startsWith('353') || d.startsWith('44')) return null
  if (!intl) return null
  if (d.startsWith('0')) return null
  if (d.length < 8 || d.length > 15) return null
  if (/^([0-9])\1+$/.test(d)) return null
  if (d.startsWith('1') && !WA_NANP.test(d)) return null
  return d
}

/** waPhoneFromPhone with the '+' (display / E.164 string form), or null. */
export function toWhatsAppE164(raw) {
  const d = waPhoneFromPhone(raw)
  return d ? `+${d}` : null
}

/**
 * The number to WhatsApp a contact on: the stored wa_phone (which may have
 * been learned from an inbound message and differ from `phone`) as digits,
 * else the phone through waPhoneFromPhone. Null when neither maps.
 * @param {{ wa_phone?: string|null, phone?: string|null }|null|undefined} contact
 */
export function contactWhatsAppNumber(contact) {
  const stored = contact?.wa_phone ? String(contact.wa_phone).replace(/[^0-9]/g, '') : ''
  if (stored) return stored
  return waPhoneFromPhone(contact?.phone)
}
