// ZOOMSYNC.4 — "will Zoom accept this number?", asked BEFORE it becomes a job.
//
// normaliseForZoom() answers a different question: "can this CRM string be read
// as a phone number at all". It is a SHAPE check — separators, bidi marks, a
// trunk zero, a bare national number. Everything it returns looks like E.164,
// and until now that was treated as good enough to publish.
//
// It is not. Since 2026-08-06 the nightly reconcile has enqueued the same
// handful of creates every night and Zoom has rejected every one of them with
//   400 Phone number (+87654567890) must be E.164 format.
// 280 such errors in 7 days. Nothing validated the number before enqueue and a
// permanent 400 was not parked, so the diff re-derived them the next night and
// the loop never terminated.
//
// The four numbers named in the runtime log fail for two different reasons, and
// the split is the whole design of this file:
//   +87654567890     — 11 digits, so the bare-number length rule in
//                      normaliseForZoom passes it. But 87 is not an ASSIGNED
//                      country calling code, so there is no country to parse it
//                      against. Needs a country-code table.
//   +800860588525    — +800 IS assigned, as UIFN (a global toll-free service
//                      code). It is not a subscriber line and cannot be a
//                      directory entry. Needs the service codes named.
//   +35382247706573  — a real country code (+353) with 11 national digits.
//   +35386921983289  — same. Ireland's national number is at most 10 digits, so
//                      neither is dialable. Needs a per-country LENGTH rule;
//                      hard E.164 (max 15 digits) accepts both.
//
// WHAT THIS DELIBERATELY DOES NOT DO
//
// It never repairs. ZOOMSYNC.2 shipped after normaliseForZoom INFERRED a
// country code — a bare US number missing its +1 was published as a Greek
// +69… under a real member's name. The lesson recorded then holds here: a
// wrong entry in a shared directory is worse than no entry, so this function
// only ever answers yes or no.
//
// It is also deliberately LOOSER than a full phone-number library, and that
// asymmetry is the point. Measured against the live desired set (6,339 distinct
// numbers, 19 Aug):
//   • these rules reject 12 — and the nightly run's permanent-failure floor is
//     ~10-13 creates, so this is very close to exactly the failing population;
//   • libphonenumber-js's isValid() with full metadata rejects 69, of which
//     ~56 are numbers Zoom ACCEPTED and is holding right now (wrong national
//     prefixes, odd landline lengths). Adopting it would strip those members
//     out of the desired state.
// Over-rejecting silently removes real members from staff handsets. Under-
// rejecting costs one Zoom 400, which ZOOMSYNC.4's second half now parks and
// shows an operator. The cheap failure is the one to prefer, so the length
// rules below cover only the markets we actually have authority over (IE, GB,
// NANP — 97% of the data) and every other country gets the E.164 rules alone.
//
// The ranges for those three are the possible-length metadata from
// libphonenumber's own tables, read at design time (IE 7-10, GB 7-10, NANP 10)
// — not a runtime dependency, and not remembered.

/**
 * Assigned country calling codes (ITU-T E.164 assignment list). Longest match
 * wins: '353' before '35' before '3'. Unassigned prefixes (87, 89, 214, …) are
 * absent on purpose — that absence is what rejects +87654567890.
 */
export const ASSIGNED_COUNTRY_CODES = Object.freeze(new Set([
  '1',
  // Zone 2 — Africa
  '20', '211', '212', '213', '216', '218',
  '220', '221', '222', '223', '224', '225', '226', '227', '228', '229',
  '230', '231', '232', '233', '234', '235', '236', '237', '238', '239',
  '240', '241', '242', '243', '244', '245', '246', '247', '248', '249',
  '250', '251', '252', '253', '254', '255', '256', '257', '258',
  '260', '261', '262', '263', '264', '265', '266', '267', '268', '269',
  '27', '290', '291', '297', '298', '299',
  // Zones 3/4 — Europe
  '30', '31', '32', '33', '34',
  '350', '351', '352', '353', '354', '355', '356', '357', '358', '359',
  '36', '370', '371', '372', '373', '374', '375', '376', '377', '378', '379',
  '380', '381', '382', '383', '385', '386', '387', '389',
  '39', '40', '41', '420', '421', '423', '43', '44', '45', '46', '47', '48', '49',
  // Zone 5 — Latin America
  '500', '501', '502', '503', '504', '505', '506', '507', '508', '509',
  '51', '52', '53', '54', '55', '56', '57', '58',
  '590', '591', '592', '593', '594', '595', '596', '597', '598', '599',
  // Zone 6 — South-East Asia / Oceania
  '60', '61', '62', '63', '64', '65', '66',
  '670', '672', '673', '674', '675', '676', '677', '678', '679',
  '680', '681', '682', '683', '685', '686', '687', '688', '689',
  '690', '691', '692',
  // Zone 7 — Russia / Kazakhstan
  '7',
  // Zone 8 — East Asia
  '81', '82', '84', '850', '852', '853', '855', '856', '86', '880', '886',
  // Zone 9 — South / West Asia
  '90', '91', '92', '93', '94', '95',
  '960', '961', '962', '963', '964', '965', '966', '967', '968',
  '970', '971', '972', '973', '974', '975', '976', '977', '98',
  '992', '993', '994', '995', '996', '998',
]))

/**
 * Assigned, but not a subscriber line: global service codes and satellite/
 * network ranges. A phone directory maps a number to a PERSON, and none of
 * these identify one. +800 (UIFN) is the one that actually bit us.
 *
 * Kept as a separate set from the omission above so the reject reason can say
 * which of the two happened — "not a country" and "not a person's phone" are
 * different corrections for whoever fixes the CRM row.
 */
export const SERVICE_COUNTRY_CODES = Object.freeze(new Set([
  '388', // ETNS
  '800', // UIFN — universal international freephone
  '808', // universal international shared cost
  '870', // Inmarsat SNAC
  '878', // universal personal telecommunications
  '881', // global mobile satellite
  '882', '883', // international networks
  '888', // OCHA / disaster relief
  '979', // international premium rate
  '991', // ITPCS trial
]))

/**
 * National significant number length bounds, per country code, for the markets
 * this CRM actually serves. A country absent here is checked against the E.164
 * rules only — see the file header on why that asymmetry is deliberate.
 *
 * Ranges, not exact sets: Ireland genuinely uses 7 (rural landline) through 10
 * (some mobile ranges) digits, and Britain 7 through 10. Widening a bound is
 * safe (Zoom rejects what it rejects and the worker parks it); narrowing one
 * deletes members from handsets.
 */
export const NATIONAL_LENGTHS = Object.freeze({
  353: [7, 10],  // Ireland
  44: [7, 10],   // United Kingdom
  1: [10, 10],   // NANP — always exactly 10, by definition of the plan
})

/**
 * Country codes whose national significant number LEGITIMATELY begins with 0,
 * so the trunk-zero rule below must not fire for them.
 *
 * The splice this catches (a national trunk prefix left in front of a national
 * number that already carries its country code) is wrong in almost every
 * country — but not all, and the first draft of this file asserted "every",
 * which would have silently dropped a real member.
 *   '39'  Italy — the well-known exception. Since the 1998 renumbering the
 *         leading 0 is part of the number itself for LANDLINES, so Rome is
 *         +39 06… and Milan +39 02…. Italian MOBILES start 3 and are
 *         unaffected either way.
 *   '378' San Marino — dialled through the Italian plan, +378 0549 ……
 *   '225' Côte d'Ivoire — the 2021 move to 10 digits put 01/05/07/25/27 at the
 *         front of the national number, zero included.
 *
 * NOT EXHAUSTIVE, and deliberately so. Several African plans renumbered the
 * same way (Gabon +241 is the likely next member) but are unconfirmed here and
 * hold zero rows in prod, so they are left out rather than guessed at. Getting
 * that wrong in this direction is the CHEAP failure and is now self-announcing:
 * an omitted country's number is rejected before enqueue, appears in the
 * rejects report on /settings/integrations/zoom-contacts under "Country code
 * followed by a national 0", and adding its code here is the whole fix. The
 * expensive direction is the opposite one, so widen this set on evidence and
 * never narrow it.
 */
export const NSN_KEEPS_LEADING_ZERO = Object.freeze(new Set(['39', '378', '225']))

// E.164: a '+', a non-zero leading digit, at most 15 digits total. The lower
// bound of 8 matches normaliseForZoom's MIN_DIGITS rather than E.164's
// theoretical minimum — nothing shorter has ever been a real member's number.
const E164_SHAPE = /^\+[1-9]\d{7,14}$/

/** Longest-prefix country-code match, or null when nothing matches. */
export function countryCodeOf(digits) {
  for (const len of [3, 2, 1]) {
    const prefix = digits.slice(0, len)
    if (ASSIGNED_COUNTRY_CODES.has(prefix) || SERVICE_COUNTRY_CODES.has(prefix)) return prefix
  }
  return null
}

/**
 * Why Zoom would refuse to hold this number, or null when it is publishable.
 *
 * @param {string} e164 — output of normaliseForZoom(); '+' followed by digits.
 * @returns {null | 'not_e164' | 'unassigned_country_code' | 'service_number' | 'trunk_zero' | 'national_length'}
 */
export function e164Rejection(e164) {
  if (typeof e164 !== 'string' || !E164_SHAPE.test(e164)) return 'not_e164'

  const digits = e164.slice(1)
  const cc = countryCodeOf(digits)
  if (!cc) return 'unassigned_country_code'
  if (SERVICE_COUNTRY_CODES.has(cc)) return 'service_number'

  const nsn = digits.slice(cc.length)
  // A national trunk prefix (the 0 in 087…, 07…) is national notation. E.164
  // has no place for it, so a 0 straight after the country code means the two
  // notations were spliced: +4407502871075, +9109607976617, +35300000000 are
  // all live rows. Caught here rather than in a length rule because it is wrong
  // in almost every country — including the ones with no entry in
  // NATIONAL_LENGTHS below — with the handful of genuine exceptions named in
  // NSN_KEEPS_LEADING_ZERO, where the 0 is part of the number.
  if (!NSN_KEEPS_LEADING_ZERO.has(cc) && nsn.startsWith('0')) return 'trunk_zero'
  // Only reachable for an exempt country, where the check above no longer
  // stands between a placeholder and the directory. An all-zero national
  // number is not one, in Italy or anywhere else.
  if (/^0+$/.test(nsn)) return 'national_length'
  // Nothing real is a country code plus three digits; this also stops a
  // truncated import passing on a country code alone.
  if (nsn.length < 4) return 'national_length'

  const bounds = NATIONAL_LENGTHS[cc]
  if (bounds && (nsn.length < bounds[0] || nsn.length > bounds[1])) return 'national_length'

  return null
}

/** Convenience predicate. Same rules, no reason. */
export function isPublishableE164(e164) {
  return e164Rejection(e164) === null
}

/** Operator-facing wording for a reject reason. Used by the settings report. */
export const E164_REJECTION_LABELS = Object.freeze({
  not_e164: 'Not a valid international number',
  unassigned_country_code: 'No such country dialling code',
  service_number: 'Service number, not a personal line',
  trunk_zero: 'Country code followed by a national 0',
  national_length: 'Wrong number of digits for that country',
})
