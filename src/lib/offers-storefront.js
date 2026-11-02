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
export const CATEGORY_ORDER = ['membership', 'class_pack', 'gift_card']

const GIFT_HERO = {
  marquee: 'UN1T GIFT CARDS · TRAINING THEY WILL ACTUALLY USE · ',
  line1: 'GIVE THE GIFT',
  line2: 'OF TRAINING',
  blurb: 'A UN1T gift card is coached strength and conditioning, 45 minutes at a time. Pick a value, pay in two minutes, and we will send you everything you need to hand it over.',
  title: 'Gift Cards — UN1T Stillorgan',
}

const MEMBERSHIP_HERO = {
  marquee: 'LOCK IN YOUR MEMBERSHIP · ',
  line1: 'LOCK IN YOUR',
  line2: 'MEMBERSHIP',
  blurb: 'Every plan comes with extra time or extra classes on the house. Pay once, train more, done.',
  title: 'Lock In Your Membership — UN1T Stillorgan',
}

const CLASSES_HERO = {
  marquee: 'LOCK IN YOUR CLASSES · ',
  line1: 'LOCK IN YOUR',
  line2: 'CLASSES',
  blurb: 'Every pack comes with extra classes on the house. Pay once, train more, done.',
  title: 'Lock In Your Classes — UN1T Stillorgan',
}

function heroForCategories(cats) {
  const giftOnly = cats.size > 0 && cats.size === 1 && cats.has('gift_card')
  if (giftOnly) return GIFT_HERO
  if (cats.has('membership')) return MEMBERSHIP_HERO
  if (cats.has('class_pack')) return CLASSES_HERO
  return MEMBERSHIP_HERO
}

/** Hero + marquee for the open offers (rows that passed offerIsOpen). */
export function heroFor(offers) {
  return heroForCategories(new Set((offers || []).map((o) => o.category)))
}

/** Browser-tab title for a Set of active categories (the layout's metadata). */
export function storefrontTitle(categories) {
  return heroForCategories(categories instanceof Set ? categories : new Set(categories || [])).title
}
