// CORPPROMO.1 — the /corp corporate promos. Pure, no IO.
//
// A promo is a definition, not a page: the studio it runs at, the credits it
// puts on the person's un1t.online account and how long they last. The page
// and the claim route only ever pick from this registry, so a visitor can
// never ask for another amount or studio. The words a visitor reads live on a
// `corp_promo` block of the studio's landing row (edited at
// /settings/landing-page), each blank field on the default below.
//
// Only a un1t.online studio can run a promo today (the grant is
// grantPromoCredits in src/lib/un1t-online-write-ops.js).

/** @typedef {{ key: string, studio: 'hatch', publicPath: string, credits: number, expiresInDays: number, tag: string, leadSource: string, live: boolean }} CorpPromo */

/** @type {Readonly<Record<string, CorpPromo>>} */
export const CORP_PROMOS = Object.freeze({
  // Richard, 28 Oct 2026: 3 free classes at Hatch Street, credits for 7 days,
  // anyone with the link who has never trained at Hatch.
  'hatch-3-free': Object.freeze({
    key: 'hatch-3-free',
    studio: 'hatch',
    publicPath: 'hatch-street',
    credits: 3,
    expiresInDays: 7,
    tag: 'hatch-corp-promo',
    leadSource: 'corp_promo',
    live: true,
  }),
})

/** The promo for `key`, or null when unknown. */
export function resolveCorpPromo(key) {
  if (typeof key !== 'string') return null
  return Object.hasOwn(CORP_PROMOS, key) ? CORP_PROMOS[key] : null
}

/** The live promos, in registry order. */
export function liveCorpPromos() {
  return Object.values(CORP_PROMOS).filter((p) => p.live)
}

export const CORP_PROMO_COPY_DEFAULT = Object.freeze({
  // The big line at the top of the /corp card (and the browser tab).
  title: 'Exclusive Corporate Trial',
  // No eyebrow by default (Richard, 28 Oct 2026): the heading names the studio.
  eyebrow: '',
  heading: '3 free classes at {studio_name}',
  subhead: 'Coach-led strength and conditioning. Your first three classes are on us: claim them in under a minute and book in the app.',
  ticks: Object.freeze(['3 coach-led classes, free', 'Use them within 7 days', 'Book in the un1t.online app']),
  cta_label: 'Claim my 3 free classes',
  consent_label: "I'd like to hear from {studio_name} about my classes and offers by email, SMS and WhatsApp. I can opt out anytime.",
  done_title: "You're in 🎉",
  done_body: 'Your {credits} free classes are on your un1t.online account. Use them by {expires_on}. Check your email for how to log in and book.',
  trained_text: "It looks like you've trained with us at {studio_name} before, so this offer is for people new to the studio. If that's not right, reply to our email or ask at the front desk.",
  already_claimed_text: "You've already claimed this offer, so your free classes are on your un1t.online account. Book them in the app; if they're not there, reply to our email.",
  trial_used_text: "It looks like this email or mobile has already had a free trial with us, so the offer can't be claimed again. If that's not right, reply to our email or ask at the front desk.",
  active_member_text: "It looks like you're already a member at {studio_name}, so your classes are covered. If that's not right, ask at the front desk.",
  help_text: "Thanks, we've got your details. Something needs a quick check on our side, so the team will be in touch shortly to get your classes on your account.",
  unavailable_text: 'This offer is not available right now.',
  email_subject: 'Your {credits} free classes at {studio_name}',
  email_body: 'Hi {first_name}, your {credits} free classes at {studio_name} are on your un1t.online account. Use them by {expires_on}. If you are new to un1t.online, a code to set your password is on its way in a separate email; once you are in, book your classes in the app. Reply to this email if anything looks off.',
})

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)
const TEXT_FIELDS = Object.keys(CORP_PROMO_COPY_DEFAULT).filter((k) => k !== 'ticks')

/**
 * The words for `promoKey` off a studio's landing blocks: the corp_promo block
 * naming that promo, else the first corp_promo block with no promo key, every
 * blank or missing field on its default. Pure.
 */
export function corpPromoCopyFromBlocks(blocks, promoKey) {
  const list = (Array.isArray(blocks) ? blocks : []).filter((b) => b && typeof b === 'object' && b.type === 'corp_promo')
  const block = list.find((b) => str(b.promo_key) === promoKey) || list.find((b) => !str(b.promo_key)) || {}
  const out = {}
  for (const k of TEXT_FIELDS) out[k] = str(block[k]) || CORP_PROMO_COPY_DEFAULT[k]
  const ticks = Array.isArray(block.ticks) ? block.ticks.map(str).filter(Boolean) : []
  out.ticks = ticks.length > 0 ? ticks : [...CORP_PROMO_COPY_DEFAULT.ticks]
  return out
}

/** `{token}` replaced from `tokens`; an unknown token stays as written. Pure. */
export function fillCorpPromoTokens(text, tokens) {
  return String(text ?? '').replace(/\{(\w+)\}/g, (m, k) => (Object.hasOwn(tokens, k) && tokens[k] != null ? String(tokens[k]) : m))
}
