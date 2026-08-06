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

const MIN_DIGITS = 8
const MAX_DIGITS = 15

export function normaliseForZoom(raw) {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (!s) return null

  const hasPlus = s.startsWith('+')
  let digits = s.replace(/\D/g, '')
  if (!digits) return null

  // 00 is the other way of writing +.
  if (!hasPlus && digits.startsWith('00')) digits = digits.slice(2)

  // Irish country code followed by the national trunk zero. The trunk zero is
  // only ever used in place of the country code, never after it.
  if (digits.startsWith('3530')) digits = `353${digits.slice(4)}`

  // A UK mobile typed nationally: 07 + 9 digits. Must be tested BEFORE the
  // Irish branch below, which would otherwise claim every leading zero for
  // +353. Lengths disambiguate cleanly — an Irish national mobile is 08X + 7
  // = 10 digits, a UK one is 11. Same rule as UK_MOBILE_NATIONAL in
  // src/lib/phone-validate.js. 4 rows in `contacts` are stored this way.
  if (!hasPlus && /^07\d{9}$/.test(digits)) {
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

  if (digits.length < MIN_DIGITS || digits.length > MAX_DIGITS) return null
  if (digits.startsWith('0')) return null      // no country code starts with 0
  if (/^(\d)\1+$/.test(digits)) return null    // 1111…, 0000…

  // The ClassPass placeholder. Excluded by lead_source upstream too; belt and
  // braces, because it is a syntactically valid US number.
  if (digits === '10000000000') return null

  return `+${digits}`
}
