// offer-studios.js — the per-studio Black Friday /offers/[studio] pages
// (BLACKFRIDAY.2). The URL key maps to a locations.slug; the page copy
// lives on locations.settings.offers_page with defaults here. Server-only
// (resolveOfferStudio reads `locations` through the service-role client).

export const OFFER_STUDIOS = {
  stillorgan: { key: 'stillorgan', locationSlug: 'un1t-stillorgan', label: 'UN1T Stillorgan' },
  'hatch-street': { key: 'hatch-street', locationSlug: 'un1t-hatch-street', label: 'UN1T Hatch Street' },
}

export function studioForKey(key) {
  if (typeof key !== 'string' || !Object.hasOwn(OFFER_STUDIOS, key)) return null
  return OFFER_STUDIOS[key]
}

export function studioForLocationSlug(slug) {
  return Object.values(OFFER_STUDIOS).find((s) => s.locationSlug === slug) || null
}

// Named columns only: the location row also carries credentials in
// `settings`, and callers must pass it through redactLocationSecrets before
// any client component sees it.
const LOCATION_COLUMNS = 'id, slug, name, organization_id, membership_source, settings'

export async function resolveOfferStudio(db, key) {
  const studio = studioForKey(key)
  if (!studio) return null
  const { data, error } = await db
    .from('locations')
    .select(LOCATION_COLUMNS)
    .eq('slug', studio.locationSlug)
    .maybeSingle()
  if (error) throw error
  if (!data) return null
  return { studio, location: data }
}

export const DEFAULT_OFFERS_PAGE_COPY = {
  marquee: 'BLACK FRIDAY HEAD START · ',
  line1: 'BLACK FRIDAY',
  line2: 'HEAD START',
  blurb: 'Bonus time and classes on every membership and pack.',
  legalLine: '',
  infoBlocks: [
    {
      title: 'Current members',
      lines: [
        'Bring a friend: the friend gets a free Reset + Black Friday pricing',
        'Free HYROX SIM or UN1TY entry for each friend who joins',
        'Most friends brought in wins 3 months free',
      ],
    },
    {
      title: 'Former members',
      lines: [
        'Rejoin for the €99 first month, plus Black Friday bonuses',
        'Bring a friend free for 1 month',
        'Talk to the team at the desk or reply to our email to rejoin',
      ],
    },
    {
      title: 'Black Friday Open Week',
      lines: [
        '23–29 Nov at the studio',
        'Come and try a class, and bring a friend',
      ],
    },
  ],
  // OFFERSDESIGN.1 — the storefront redesign's operator fields. Each is
  // optional: an empty one hides its part of the page, so nothing invented
  // ever shows (no default photo, rating or FAQ answer).
  //   heroImage     absolute https URL of the hero photo (a resized
  //                 Supabase render URL keeps it light);
  //   proofLine     one line of social proof beside the sale end date;
  //   audienceLinks the "who are you" row under the hero: title, hint and
  //                 the section it jumps to (memberships | packs | members);
  //   faq           questions and answers above the footer.
  heroImage: '',
  proofLine: '',
  audienceLinks: [
    { title: 'New to UN1T', hint: 'See the memberships', target: 'memberships' },
    { title: 'Coming back', hint: 'Rejoin offers', target: 'members' },
    { title: 'Already a member', hint: 'Bring a friend', target: 'members' },
  ],
  faq: [],
  // OFFERSTOCK.1 — the stock wording. {n} is how many are really left.
  stockLeft: 'Only {n} left',
  stockReserved: 'Last ones in checkout',
  stockReservedBody: "The last ones are in someone's checkout right now. Any payment that isn't finished comes back within about 35 minutes.",
  soldOut: 'Sold out',
  soldOutBody: 'Every one of these has gone. Have a look at the other offers.',
}

// The sections an audience link may jump to (ids on the storefront page).
export const AUDIENCE_TARGETS = ['memberships', 'packs', 'gifts', 'members', 'faq']

function text(v, fallback, allowEmpty = false) {
  if (typeof v !== 'string') return fallback
  if (!allowEmpty && !v.trim()) return fallback
  return v
}

function blocks(v, fallback) {
  if (!Array.isArray(v) || v.length === 0) return fallback
  const ok = v.every((b) => b && typeof b.title === 'string' && Array.isArray(b.lines)
    && b.lines.every((l) => typeof l === 'string'))
  return ok ? v : fallback
}

function httpsUrl(v) {
  return typeof v === 'string' && /^https:\/\/[^\s]+$/.test(v.trim()) ? v.trim() : ''
}

function audienceLinks(v, fallback) {
  if (!Array.isArray(v)) return fallback
  const ok = v.every((l) => l && typeof l.title === 'string' && l.title.trim()
    && typeof l.hint === 'string' && AUDIENCE_TARGETS.includes(l.target))
  return ok ? v : fallback
}

function faq(v, fallback) {
  if (!Array.isArray(v)) return fallback
  const ok = v.every((f) => f && typeof f.q === 'string' && f.q.trim() && typeof f.a === 'string' && f.a.trim())
  return ok ? v : fallback
}

/** Page copy for a location row: settings.offers_page over the defaults, field by field. */
export function offersPageCopy(location) {
  const o = location?.settings?.offers_page
  const s = o && typeof o === 'object' ? o : {}
  const d = DEFAULT_OFFERS_PAGE_COPY
  return {
    marquee: text(s.marquee, d.marquee),
    line1: text(s.line1, d.line1),
    line2: text(s.line2, d.line2),
    blurb: text(s.blurb, d.blurb),
    legalLine: text(s.legalLine, d.legalLine, true),
    infoBlocks: blocks(s.infoBlocks, d.infoBlocks),
    heroImage: httpsUrl(s.heroImage),
    proofLine: text(s.proofLine, d.proofLine, true).trim(),
    audienceLinks: audienceLinks(s.audienceLinks, d.audienceLinks),
    faq: faq(s.faq, d.faq),
    stockLeft: text(s.stockLeft, d.stockLeft),
    stockReserved: text(s.stockReserved, d.stockReserved),
    stockReservedBody: text(s.stockReservedBody, d.stockReservedBody),
    soldOut: text(s.soldOut, d.soldOut),
    soldOutBody: text(s.soldOutBody, d.soldOutBody),
  }
}

// BLACKFRIDAY.9 — ONE payment-rail rule for an offer, used by the checkout
// handler (offer-checkout.js) and the product page (/offers/[studio]/[slug]),
// so the page never shows a form the handler would refuse.
//   'un1t_online'    a un1t.online studio's membership or class pack that names
//                    its un1t.online product: un1t.online's hosted checkout.
//   'not_configured' that studio/category combination with no product id yet,
//                    OR any offer carrying a un1t_product_id outside it (a
//                    product-carrying row must never be sold through Revolut).
//   'revolut'        everything else.
export const UN1T_RAIL_CATEGORIES = new Set(['membership', 'class_pack'])

/**
 * @param {{ membership_source?: string|null }|null} location
 * @param {{ category?: string|null, un1t_product_id?: string|null }|null} offer
 * @returns {'un1t_online'|'revolut'|'not_configured'}
 */
export function offerRail(location, offer) {
  const hasProduct = typeof offer?.un1t_product_id === 'string' ? offer.un1t_product_id.trim() !== '' : !!offer?.un1t_product_id
  const un1tCombo = location?.membership_source === 'un1t_online' && UN1T_RAIL_CATEGORIES.has(offer?.category)
  if (un1tCombo) return hasProduct ? 'un1t_online' : 'not_configured'
  if (hasProduct) return 'not_configured'
  return 'revolut'
}

/**
 * What the product page's right-hand panel shows (BLACKFRIDAY.9). A
 * `?purchase=` return resumes whatever the window says (a late payment is
 * honoured), except when it carries `cancelled=1`: un1t.online's cancel URL is
 * the success URL plus that flag, and a buyer who cancelled must never see
 * "Thanks, your payment is with un1t.online".
 * A sold-out offer (OFFERSTOCK.1) replaces the form; a buyer returning from a
 * payment still resumes, because their purchase is already under way.
 * @param {{ open: boolean, upcoming: boolean, purchase?: string|null, cancelled?: boolean, soldOut?: boolean }} args
 * @returns {'resume'|'form'|'sold_out'|'upcoming'|'ended'}
 */
export function offerPageMode({ open, upcoming, purchase = null, cancelled = false, soldOut = false }) {
  if (purchase && !cancelled) return 'resume'
  if (open) return soldOut ? 'sold_out' : 'form'
  if (upcoming) return 'upcoming'
  return 'ended'
}
