// ZOOMSYNC.3 — triage the bare-digit phone numbers ZOOMSYNC.2 now rejects.
//
// The ZOOMSYNC.1 go-live pilot found 46 non-ClassPass `contacts` rows holding a
// phone as 8 or 10 bare digits with no '+' and no country code (37 ten-digit, 9
// eight-digit; measured 2026-08-06). normaliseForZoom() used to splice a country
// code out of their leading digits, so 6978291516 — a Greek mobile stored
// without its +30 — went to Zoom as +6978291516. Zoom rejected that one because
// 69 is unassigned, which was luck: a fabricated code that IS assigned publishes
// silently as a wrong number under a real member's name. ZOOMSYNC.2 (#1235)
// closed that with `!hasPlus && digits.length < 11`, so these rows are simply
// absent from the caller-ID directory. The data is still wrong and still
// repairable — that is what this module is for.
//
// It does NOT repair anything. It classifies each row into a tier and shows its
// working, so a human decides. The rule that matters: a bare 10-digit number is
// PROBABLY North American, but it could equally be a mistyped Irish number, and
// guessing wrong writes a stranger's number against a real member's name — the
// exact failure ZOOMSYNC.2 just closed. Never re-introduce it as a bulk
// UPDATE ... SET phone = '+1' || phone.
//
//   derived      A known-good E.164 already on the contact (wa_phone, or a
//                whatsapp_conversations thread) ENDS WITH the bare digits, so
//                the stored value is a truncation of a number we already hold.
//                The country code is read off, not guessed. No judgement.
//   corroborated The digit shape maps to exactly one country AND at least one
//                independent non-phone signal agrees. A proposal for review,
//                never an instruction.
//   ambiguous    No corroboration, or signals disagree. Left alone by design.

// Assigned NANP area codes. Structural validity ([2-9][0-9][0-9]) is NOT enough:
// 697 is structurally fine and is exactly the Greek number that started this.
// Membership here is what separates "plausibly North American" from "three
// digits that merely look like an area code". Not exhaustive — new codes are
// assigned over time — but a miss only costs a row its `corroborated` tier and
// drops it to `ambiguous`, which is the safe direction to be wrong in.
const NANP_AREA_CODES = new Set([
  201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 212, 213, 214, 215, 216, 217, 218, 219, 220,
  223, 224, 225, 226, 227, 228, 229, 231, 234, 236, 239, 240, 242, 246, 248, 249, 250, 251, 252,
  253, 254, 256, 260, 262, 263, 264, 267, 268, 269, 270, 272, 274, 276, 279, 281, 283, 284, 289,
  301, 302, 303, 304, 305, 306, 307, 308, 309, 310, 312, 313, 314, 315, 316, 317, 318, 319, 320,
  321, 323, 325, 326, 327, 330, 331, 332, 334, 336, 337, 339, 340, 341, 343, 345, 346, 347, 351,
  352, 354, 360, 361, 363, 364, 365, 367, 368, 369, 380, 385, 386, 387,
  401, 402, 403, 404, 405, 406, 407, 408, 409, 410, 412, 413, 414, 415, 416, 417, 418, 419, 423,
  424, 425, 428, 430, 431, 432, 434, 435, 437, 438, 440, 441, 442, 443, 445, 447, 448, 450, 458,
  463, 464, 468, 469, 470, 473, 474, 475, 478, 479, 480, 484,
  501, 502, 503, 504, 505, 506, 507, 508, 509, 510, 512, 513, 514, 515, 516, 517, 518, 519, 520,
  530, 531, 534, 539, 540, 541, 548, 551, 557, 559, 561, 562, 563, 564, 567, 570, 571, 572, 573,
  574, 575, 579, 580, 581, 582, 584, 585, 586, 587,
  601, 602, 603, 604, 605, 606, 607, 608, 609, 610, 612, 613, 614, 615, 616, 617, 618, 619, 620,
  623, 626, 628, 629, 630, 631, 636, 639, 640, 641, 646, 647, 649, 650, 651, 656, 657, 658, 659,
  660, 661, 662, 664, 667, 669, 670, 671, 672, 678, 680, 681, 682, 684, 689,
  701, 702, 703, 704, 705, 706, 707, 708, 709, 712, 713, 714, 715, 716, 717, 718, 719, 720, 721,
  724, 725, 726, 727, 731, 732, 734, 737, 740, 742, 743, 747, 753, 754, 757, 758, 760, 762, 763,
  765, 767, 769, 770, 772, 773, 774, 775, 778, 779, 780, 781, 782, 784, 785, 786, 787,
  801, 802, 803, 804, 805, 806, 807, 808, 809, 810, 812, 813, 814, 815, 816, 817, 818, 819, 820,
  825, 826, 828, 829, 830, 831, 832, 835, 838, 839, 840, 843, 845, 847, 848, 849, 850, 854, 856,
  857, 858, 859, 860, 862, 863, 864, 865, 867, 868, 869, 870, 872, 873, 876, 878, 879,
  901, 902, 903, 904, 905, 906, 907, 908, 909, 910, 912, 913, 914, 915, 916, 917, 918, 919, 920,
  925, 928, 929, 930, 931, 934, 936, 937, 938, 939, 940, 941, 943, 945, 947, 949, 951, 952, 954,
  956, 959, 970, 971, 972, 973, 978, 979, 980, 983, 984, 985, 986, 989,
])

const SEPARATORS = /[\s\-().]/g
const BIDI_MARKS = /[‎‏‪-‮⁦-⁩]/g

// Country-code TLDs that place a person somewhere specific. Generic TLDs
// (.com/.net/.org) and the global mailbox providers say nothing and are absent
// on purpose — gmail.com is not evidence of anything.
const TLD_COUNTRY = { ie: '353', gr: '30', uk: '44', us: '1', ca: '1', fr: '33', de: '49', es: '34', it: '39', pl: '48', nl: '31', pt: '351', br: '55', au: '61' }

/** Strip a raw stored phone to bare digits, or null if it is not all-digits. */
function bareDigits(raw) {
  if (typeof raw !== 'string') return null
  const s = raw.replace(BIDI_MARKS, '').trim()
  if (!s || s.startsWith('+')) return null
  const stripped = s.replace(SEPARATORS, '')
  return /^\d+$/.test(stripped) ? stripped : null
}

/** Digits of a known-good stored E.164, or null. */
function e164Digits(raw) {
  if (typeof raw !== 'string') return null
  const s = raw.replace(BIDI_MARKS, '').trim().replace(SEPARATORS, '')
  const d = s.startsWith('+') ? s.slice(1) : s
  return /^\d{8,15}$/.test(d) && !d.startsWith('0') ? d : null
}

/**
 * Is this row in the population ZOOMSYNC.2 rejects? Mirrors that reject
 * condition (`!hasPlus && digits.length < 11`) reduced to the shapes that
 * actually reach it: bare, no leading trunk zero, not already 353-prefixed,
 * and 8 or 10 digits long. A 9-digit bare number is rewritten to +353… before
 * the check and passes, so it is NOT in scope here.
 */
export function isBareNoCountryCode(raw) {
  const d = bareDigits(raw)
  if (!d) return false
  if (d.startsWith('0') || d.startsWith('353') || d.startsWith('00')) return false
  return d.length === 8 || d.length === 10
}

/**
 * Country codes the digit shape alone can support, each with a reason.
 * Shape evidence is never sufficient on its own — it must be seconded by an
 * independent non-phone signal before a row leaves `ambiguous`.
 */
function shapeHypotheses(digits) {
  const out = []
  if (digits.length === 10) {
    const area = Number(digits.slice(0, 3))
    const exchange = digits.slice(3, 6)
    const structural = /^[2-9]\d\d$/.test(digits.slice(0, 3)) && /^[2-9]\d\d$/.test(exchange) && !/^\d11$/.test(exchange)
    if (structural && NANP_AREA_CODES.has(area)) {
      out.push({ cc: '1', e164: `+1${digits}`, why: `NANP area code ${area} is assigned` })
    }
    // A UK mobile that lost its trunk zero: 07xxx xxxxxx written bare is
    // 7[1-9] + 8 digits, exactly ten. Measured 2026-08-06, SEVEN of the 37
    // ten-digit rows read this way — the "bare 10 digits ≈ North American"
    // assumption is wrong for a fifth of the population. 76xx is excluded
    // (pagers) and 70xx is personal numbering, not mobile, which is why
    // 7082895093 correctly reads as NANP 708 (Chicago) and not as UK.
    if (/^7[1-9]\d{8}$/.test(digits) && !/^76/.test(digits)) {
      out.push({ cc: '44', e164: `+44${digits}`, why: 'UK mobile shape (07xxx xxxxxx without the trunk zero)' })
    }
    // Greek mobiles are exactly 69X + 7 digits. This is the shape that started
    // ZOOMSYNC.2 — and 697 is not an assigned NANP code, so it does not also
    // produce a +1 hypothesis. Where both fire, the row stays ambiguous.
    if (/^69\d{8}$/.test(digits)) {
      out.push({ cc: '30', e164: `+30${digits}`, why: 'Greek mobiles are 69X + 7 digits' })
    }
  }
  if (digits.length === 8 && digits.startsWith('1')) {
    // A Dublin landline is +353 1 + 7 digits; written nationally as 01 …, it
    // loses its trunk zero to leave exactly these 8 digits. Plausible for a
    // Dublin gym, but 8 bare digits is a weak shape — corroboration required.
    out.push({ cc: '353', e164: `+353${digits}`, why: 'Dublin landline shape (353 1 + 7 digits)' })
  }
  return out
}

/**
 * Independent, non-phone evidence for where a person is. Kept separate from
 * shapeHypotheses() so a tier can never rest on the digits alone.
 */
function contextSignals(row) {
  const signals = []
  const email = typeof row.email === 'string' ? row.email.trim().toLowerCase() : ''
  const tld = email.includes('@') ? email.split('.').pop() : ''
  if (TLD_COUNTRY[tld]) signals.push({ cc: TLD_COUNTRY[tld], why: `email TLD .${tld}` })

  // Currency is deliberately NOT a signal. It reflects the MERCHANT, not the
  // member: every UN1T invoice is EUR because the gym bills in Dublin, so an
  // EUR row says nothing about where the person's phone is registered. Reading
  // it as evidence for +353 was wrong and would have fought the correct answer
  // on genuinely foreign numbers. Measured 2026-08-06: of the 46 bare rows only
  // 2 have any invoice at all, both EUR — so the rule was simultaneously wrong
  // and useless. Same trap applies to `contacts.lifetime_currency`.
  return signals
}

/**
 * Classify one contact row.
 *
 * @param {object} row  id, first_name/last_name/name, email, phone, lead_source,
 *                      wa_phone, lifetime_currency, glofox_member_id
 * @param {string[]} [threadPhones]  E.164 numbers from whatsapp_conversations
 *                                   for this contact
 */
export function inferBarePhone(row, threadPhones = []) {
  const raw = row?.phone
  const digits = bareDigits(raw)
  const base = {
    id: row?.id,
    name: [row?.first_name, row?.last_name].filter(Boolean).join(' ') || row?.name || '',
    email: row?.email || '',
    raw: typeof raw === 'string' ? raw.trim() : raw,
    lead_source: row?.lead_source || null,
    evidence: [],
    conflicts: [],
  }
  if (!digits || !isBareNoCountryCode(raw)) {
    return { ...base, tier: 'out-of-scope', e164: null, reason: 'not a bare 8/10-digit number' }
  }

  // --- derived: a number we already hold, of which this is a truncation. ---
  // Prefer the contact's own wa_phone, then any WhatsApp thread. The repair is
  // the known-good E.164 itself, not a prefix we assembled, so this cannot
  // fabricate a country code even if the prefix is an odd length.
  const known = [
    ...(e164Digits(row?.wa_phone) ? [{ d: e164Digits(row.wa_phone), src: 'contacts.wa_phone' }] : []),
    ...threadPhones.map(p => ({ d: e164Digits(p), src: 'whatsapp_conversations.wa_phone' })).filter(k => k.d),
  ]
  for (const k of known) {
    if (k.d.length <= digits.length || !k.d.endsWith(digits)) continue
    const prefix = k.d.slice(0, k.d.length - digits.length)
    if (prefix.length > 4 || prefix.startsWith('0')) continue // not a country-code-shaped remainder
    return {
      ...base,
      tier: 'derived',
      e164: `+${k.d}`,
      reason: `+${k.d} (${k.src}) ends with the stored digits — country code read off, not guessed`,
      evidence: [`${k.src} = +${k.d}`],
    }
  }

  // --- corroborated / ambiguous ---
  const hyps = shapeHypotheses(digits)
  const signals = contextSignals(row)
  base.evidence = [
    ...hyps.map(h => `shape: ${h.why} → +${h.cc}`),
    ...signals.map(s => `context: ${s.why} → +${s.cc}`),
  ]

  if (hyps.length === 0) {
    return { ...base, tier: 'ambiguous', e164: null, reason: 'digit shape matches no single country' }
  }
  if (hyps.length > 1) {
    base.conflicts.push(`shape supports more than one country: ${hyps.map(h => `+${h.cc}`).join(', ')}`)
    return { ...base, tier: 'ambiguous', e164: null, reason: 'digit shape is not decisive' }
  }

  const [hyp] = hyps
  const agreeing = signals.filter(s => s.cc === hyp.cc)
  const disagreeing = signals.filter(s => s.cc !== hyp.cc)
  if (disagreeing.length) {
    base.conflicts.push(...disagreeing.map(s => `${s.why} points to +${s.cc}, shape points to +${hyp.cc}`))
    return { ...base, tier: 'ambiguous', e164: null, reason: 'context contradicts the digit shape' }
  }
  if (!agreeing.length) {
    return { ...base, tier: 'ambiguous', e164: null, reason: `shape suggests +${hyp.cc} but nothing independent corroborates it` }
  }
  return {
    ...base,
    tier: 'corroborated',
    e164: hyp.e164,
    reason: `${hyp.why}; corroborated by ${agreeing.map(s => s.why).join(', ')}`,
  }
}

/** Classify many rows. threadsByContact maps contact id → E.164 strings. */
export function inferAll(rows, threadsByContact = {}) {
  return (rows || []).map(r => inferBarePhone(r, threadsByContact[r?.id] || []))
}
