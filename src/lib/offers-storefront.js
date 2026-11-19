// offers-storefront.js — the copy and ordering rules for the public /offers
// storefront (OFFERS.8). Pulled out of the page so the hero, the marquee and
// the tab title are decided by ONE rule, and so that rule is testable.
//
// The storefront is driven by the CATEGORY of whatever is active in
// sale_offers:
//   * gift_card only          → gift copy, no sale urgency;
//   * a sale with a membership → "lock in your membership";
//   * a sale of packs only     → "lock in your classes" (OFFERS.8: the
//     November 2026 pack sale ran under a membership headline for an hour).
// An empty storefront keeps the sale copy: the page body already says
// "Nothing on sale right now", and gift copy over nothing would be odd.

// Display order: the timed sale first, the evergreen gift cards last. A
// category with no active rows renders nothing at all.
import { DEFAULT_OFFERS_PAGE_COPY } from './offer-studios'
import { offerIsOpen, offerIsUpcoming, offerHasDeadline } from './sale-offers'

export const CATEGORY_ORDER = ['membership', 'class_pack', 'gift_card']

// The big numeral on a timed-sale card, read off the slug. The Black Friday
// rows carry a '-bf-2026' suffix (mig 829), so the 12-month row is matched by
// prefix. Null when the slug names no term (the caller falls back to the name).
export function termForSlug(slug) {
  if (slug.startsWith('1-year-membership')) return { num: '12', label: 'MONTHS' }
  const m = slug.match(/^(\d+)-month/)
  if (m) return { num: m[1], label: m[1] === '1' ? 'MONTH' : 'MONTHS' }
  const c = slug.match(/^(\d+)-class/)
  if (c) return { num: c[1], label: 'CLASSES' }
  return null
}

// OFFERSDESIGN.1 — the card leads with the bonus. OFFERSABOUT.1 took the
// "About €X a month / a class" value line off every card.

/** The small line under the bonus: "On 12 months", "On 30 classes". Null when unreadable. */
export function offerTermLine(offer) {
  const term = typeof offer?.slug === 'string' ? termForSlug(offer.slug) : null
  if (!term) return null
  return `On ${term.num} ${term.label.toLowerCase()}`
}

/**
 * Split a section's offers into the card grid and the one-month memberships,
 * which get a full-width strip of their own (a fourth card used to sit alone
 * on a second row). Order kept.
 */
export function splitMonthStrip(offers) {
  const grid = []
  const strip = []
  for (const o of offers || []) {
    const t = o?.category === 'membership' && typeof o.slug === 'string' ? termForSlug(o.slug) : null
    if (t && t.num === '1' && t.label === 'MONTH') strip.push(o)
    else grid.push(o)
  }
  return { grid, strip }
}

// The corner flag on the two headline bonuses, suffixed slugs included.
export function flagForSlug(slug) {
  if (slug.startsWith('1-year-membership')) return 'Biggest bonus'
  if (slug.startsWith('30-class-pack')) return 'Biggest pack bonus'
  return null
}

const GIFT_HERO = {
  marquee: 'UN1T GIFT CARDS · TRAINING THEY WILL ACTUALLY USE · ',
  line1: 'GIVE THE GIFT',
  line2: 'OF TRAINING',
  blurb: 'A UN1T gift card is coached strength and conditioning, 45 minutes at a time. Pick a value, pay in two minutes, and we will send you everything you need to hand it over.',
  }

const DEFAULT_STUDIO_LABEL = 'UN1T Stillorgan'

// A timed sale (any membership or class_pack present, or nothing at all)
// reads from the studio's page copy; gift-only keeps the gift wording.
function heroForCategories(cats, copy, studioLabel) {
  const giftOnly = cats.size === 1 && cats.has('gift_card')
  if (giftOnly) return { ...GIFT_HERO, title: `Gift Cards — ${studioLabel}` }
  return {
    marquee: copy.marquee,
    line1: copy.line1,
    line2: copy.line2,
    blurb: copy.blurb,
    title: `Black Friday — ${studioLabel}`,
  }
}

/** Hero + marquee for the listed offers: the open AND upcoming rows (storefrontOffers). */
export function heroFor(offers, copy = DEFAULT_OFFERS_PAGE_COPY, studioLabel = DEFAULT_STUDIO_LABEL) {
  return heroForCategories(new Set((offers || []).map((o) => o.category)), copy, studioLabel)
}

/** Browser-tab title for a Set of active categories (the layout's metadata). */
export function storefrontTitle(categories, studioLabel = DEFAULT_STUDIO_LABEL) {
  return heroForCategories(categories instanceof Set ? categories : new Set(categories || []), DEFAULT_OFFERS_PAGE_COPY, studioLabel).title
}

/**
 * OFFERSPOLISH.1 — the storefront's link-preview words for a Set of active
 * categories: the tab title and the hero blurb (operator copy, or the gift
 * blurb on a gift-only storefront). One rule with the hero.
 */
export function storefrontShare(categories, copy = DEFAULT_OFFERS_PAGE_COPY, studioLabel = DEFAULT_STUDIO_LABEL) {
  const h = heroForCategories(categories instanceof Set ? categories : new Set(categories || []), copy, studioLabel)
  return { title: h.title, description: h.blurb }
}

/** A product page's link-preview words: the offer first, then the studio. */
export function offerShare(offer, studioLabel = DEFAULT_STUDIO_LABEL) {
  const name = typeof offer?.name === 'string' ? offer.name.trim() : ''
  const description = typeof offer?.description === 'string' && offer.description.trim() !== '' ? offer.description.trim() : null
  return { title: name ? `${name} — ${studioLabel}` : `Black Friday — ${studioLabel}`, description }
}

/**
 * Next.js metadata for an /offers page (OFFERSPOLISH.1). The root layout's
 * Open Graph block names the platform, and Next replaces `openGraph` whole
 * rather than merging it, so every /offers page states its own: before this a
 * link shared on WhatsApp previewed as the platform's name with no words.
 * The image is the studio's logo and only when it is an absolute https URL
 * (a relative one needs a metadataBase this app does not set). Never indexed.
 */
export function offersShareMetadata({ title, description = null, siteName, image = null }) {
  const img = typeof image === 'string' && image.startsWith('https://') ? image : null
  const desc = typeof description === 'string' && description.trim() !== '' ? description.trim() : null
  return {
    title,
    ...(desc ? { description: desc } : {}),
    robots: { index: false, follow: false },
    openGraph: { title, ...(desc ? { description: desc } : {}), siteName, type: 'website', ...(img ? { images: [{ url: img }] } : {}) },
    twitter: { card: 'summary', title, ...(desc ? { description: desc } : {}), ...(img ? { images: [img] } : {}) },
  }
}

// BLACKFRIDAY.3 — the storefront's decisions, pure so they are testable.

const time = (iso) => new Date(iso).getTime()

/** The earliest valid instant in `column` among rows; rows lacking it are skipped. */
function earliest(rows, column) {
  return rows
    .filter((r) => r?.[column] != null && !Number.isNaN(time(r[column])))
    .reduce((best, r) => (best === null || time(r[column]) < time(best) ? r[column] : best), null)
}

/** The rows a storefront lists: active and open, or active and not yet open. Order kept. */
export function storefrontOffers(rows, now = new Date()) {
  return (rows || []).filter((o) => offerIsOpen(o, now) || offerIsUpcoming(o, now))
}

/**
 * The header countdown: "Sale ends" against the earliest-closing open dated
 * row, else "Opens" against the earliest start among upcoming rows, else null.
 * Gift cards (ends_at NULL) never drive a "Sale ends".
 * @returns {{ label: 'Sale ends'|'Opens', at: string, doneLabel: string } | null}
 */
export function storefrontCountdown(offers, now = new Date()) {
  const list = offers || []
  const endsAt = earliest(list.filter((o) => offerIsOpen(o, now) && offerHasDeadline(o)), 'ends_at')
  if (endsAt) return { label: 'Sale ends', at: endsAt, doneLabel: 'SALE ENDED' }
  const opensAt = earliest(list.filter((o) => offerIsUpcoming(o, now)), 'starts_at')
  if (opensAt) return { label: 'Opens', at: opensAt, doneLabel: 'NOW OPEN' }
  return null
}

/**
 * True for a gift card that opens after the memberships do (the Cyber Monday
 * drop). `offers` is the listed set the earliest membership start is read from.
 */
export function isCyberMondayOnly(offer, offers) {
  if (offer?.category !== 'gift_card' || offer.starts_at == null) return false
  const firstMembershipStart = earliest((offers || []).filter((o) => o?.category === 'membership'), 'starts_at')
  if (!firstMembershipStart) return false
  const t = time(offer.starts_at)
  return !Number.isNaN(t) && t > time(firstMembershipStart)
}

/**
 * An offer's fine print, or null when it has none (BLACKFRIDAY.9). The card
 * shows it for ANY studio's offer that carries some; it used to be gated on
 * the Hatch Street key, so a Stillorgan row's fine print never appeared.
 */
export function offerFinePrint(offer) {
  const v = offer?.fine_print
  return typeof v === 'string' && v.trim() !== '' ? v : null
}
