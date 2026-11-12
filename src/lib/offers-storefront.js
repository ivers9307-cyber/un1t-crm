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

export const CATEGORY_ORDER = ['membership', 'class_pack', 'gift_card']

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

/** Hero + marquee for the open offers (rows that passed offerIsOpen). */
export function heroFor(offers, copy = DEFAULT_OFFERS_PAGE_COPY, studioLabel = DEFAULT_STUDIO_LABEL) {
  return heroForCategories(new Set((offers || []).map((o) => o.category)), copy, studioLabel)
}

/** Browser-tab title for a Set of active categories (the layout's metadata). */
export function storefrontTitle(categories, studioLabel = DEFAULT_STUDIO_LABEL) {
  return heroForCategories(categories instanceof Set ? categories : new Set(categories || []), DEFAULT_OFFERS_PAGE_COPY, studioLabel).title
}
