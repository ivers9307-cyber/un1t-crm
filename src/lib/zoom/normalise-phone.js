// ZOOMSYNC.1 — raw CRM phone string → E.164, or null when unusable.
//
// Deliberately NOT src/lib/phone-validate.js's toMobileE164(): that helper
// gates public forms on WhatsApp reachability so it rejects every landline,
// and a landline that rings the studio still deserves a name on the handset.
//
// The trunk-zero rule is the one that matters. 106 rows are stored as country
// code 353 followed by the national trunk 0 (+3530871234567). Left alone those
// look like a well-formed foreign number and would be published against a real
// member's name.

// Unicode direction marks. WhatsApp and iOS wrap pasted numbers in these, and
// String.trim() does not remove them — left in, they hide a leading '+'.
const BIDI_MARKS = /[‎‏‪-‮⁦-⁩]/g
// The only characters a human legitimately types inside a phone number.
const SEPARATORS = /[\s\-().]/g
const UK_MOBILE_NATIONAL = /^07\d{9}$/

const MIN_DIGITS = 8
const MAX_DIGITS = 15

export function normaliseForZoom(raw) {
  if (typeof raw !== 'string') return null
  const s = raw.replace(BIDI_MARKS, '').trim()
  if (!s) return null

  const hasPlus = s.startsWith('+')
  const stripped = (hasPlus ? s.slice(1) : s).replace(SEPARATORS, '')

  // Anything still non-digit means this is not a phone number — an email, a
  // note, a stray quote that probably ate a digit. Reject rather than splicing
  // the surviving digits into a plausible-looking wrong number: 8 rows in
  // `contacts` are stored this way, and a wrong entry in a shared directory is
  // worse than no entry.
  if (!/^\d+$/.test(stripped)) return null
  let digits = stripped

  // 00 is the other way of writing +. Must run before the national branches
  // below, or a 00-prefixed number falls through and gets treated as national.
  if (!hasPlus && digits.startsWith('00')) digits = digits.slice(2)

  // Irish country code followed by the national trunk zero. The trunk zero is
  // only ever used in place of the country code, never after it.
  if (digits.startsWith('3530')) digits = `353${digits.slice(4)}`

  // A UK mobile typed nationally: 07 + 9 digits. Must be tested BEFORE the
  // Irish branch below, which would otherwise claim every leading zero for
  // +353. Lengths disambiguate cleanly — an Irish national mobile is 08X + 7
  // = 10 digits, a UK one is 11. Same rule as UK_MOBILE_NATIONAL in
  // src/lib/phone-validate.js. 4 rows in `contacts` are stored this way.
  if (!hasPlus && UK_MOBILE_NATIONAL.test(digits)) {
    digits = `44${digits.slice(1)}`
  }

  // A leading 0 with no country code is a national number; UN1T is Dublin, so
  // national means Ireland.
  if (!hasPlus && !digits.startsWith('353') && digits.startsWith('0')) {
    digits = `353${digits.slice(1)}`
  }

  // Bare national digits, no trunk zero and no country code (e.g. 871234567).
  // Only assume Ireland when the length makes it a plausible IE subscriber
  // number — otherwise we would mangle a foreign number typed without its +.
  if (!hasPlus && digits.length === 9 && !digits.startsWith('353')) {
    digits = `353${digits}`
  }

  // A bare number (no explicit +) shorter than 11 digits cannot hold both a
  // country code and a subscriber number, so nothing vouches for its leading
  // digits. Every bare form we CAN map has already been rewritten above and is
  // >= 11 digits by now: an 08x/07 national number, a 9-digit Irish subscriber
  // number, a 353- or 00-prefixed string. What reaches here is a number typed
  // without its country code — a US 3475717693 would publish as +347…, a Greek
  // 6978291516 as +69…. Zoom rejects some of those outright and SILENTLY
  // ACCEPTS the rest as a wrong number under a real member's name, which is
  // the exact harm this function exists to prevent. Found during the go-live
  // pilot; 46 rows in `contacts` are stored this way.
  if (!hasPlus && digits.length < 11) return null

  if (digits.length < MIN_DIGITS || digits.length > MAX_DIGITS) return null
  if (digits.startsWith('0')) return null      // no country code starts with 0
  if (/^(\d)\1+$/.test(digits)) return null    // 1111…, 0000…

  // The ClassPass placeholder. Excluded by lead_source upstream too; belt and
  // braces, because it is a syntactically valid US number.
  if (digits === '10000000000') return null

  return `+${digits}`
}
