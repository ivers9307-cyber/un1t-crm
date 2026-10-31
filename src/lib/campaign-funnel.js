// FIFTYPLUS.1 — the campaign_funnel block: a booking page for ONE class and
// ONE trial plan at /<campaign> (today: /50plus, THE 50+ CLUB, The Elites
// Trial). The block lives on a studio's landing row beside class_funnel and
// paid_trial, renders only in the editor there, and is read by the two public
// routes (/api/public/classes, /api/public/class-booking) and the page.
//
// Pure, no IO, importable from the client bundle. The design is
// docs/superpowers/specs/2026-10-30-50plus-landing-page-design.md.
//
// Three rules the routes rest on:
//   - the class ALLOW-list (class_keywords) is applied after the studio's
//     hidden-keyword deny-list; an empty list offers nothing, never the whole
//     timetable (readPublicClasses, public-classes.js);
//   - the trial pair is REQUIRED: a block with no plan picked is `configured:
//     false` and the booking route refuses `not_configured`, never a fallback
//     to the studio's default trial (that is the generic one);
//   - the browser gets CAMPAIGN_FUNNEL_CLIENT_FIELDS and nothing else: never
//     the Glofox ids, the keyword list or the attribution.

import { parseHiddenKeywords } from '@/lib/class-keywords'
import { classFunnelConsentDefault } from '@/lib/landing-page-blocks'

export const CAMPAIGN_FUNNEL_TYPE = 'campaign_funnel'

export const CAMPAIGN_FUNNEL_SECTIONS = Object.freeze(['stats', 'video_testimonials', 'reviews'])

// Every customer-facing string the block owns, with its default. No em-dashes
// in customer copy (CLAUDE.md). Kept in one place: CAMPAIGN_FUNNEL_DEFAULT in
// landing-page-blocks.js spreads this, and campaignFunnelCopy falls back to it.
export const CAMPAIGN_FUNNEL_COPY_DEFAULTS = Object.freeze({
  eyebrow: 'The 50+ Club · Stillorgan',
  heading: 'A free trial of The 50+ Club',
  subhead: 'Coach-led strength and mobility for the over-50s. Small group, a coach beside you, three mornings a week.',
  sound_label: 'Tap for sound',
  pick_title: 'Pick your first morning',
  pick_body: "We'll have a coach waiting at the door.",
  cta_label: 'Book {day} {time}',
  reassurance: 'Free · no card needed · 60 minutes',
  details_title: 'Last step',
  details_body: 'We just need these to book you in.',
  done_title: "You're booked in",
  done_body: "That's your first 50+ Club class. Watch for a WhatsApp confirming it. See you at the door.",
  no_classes_text: 'No 50+ Club classes are open to book in the next two weeks. Message us and we will sort you out.',
  not_configured_text: 'Booking is not open online right now. Message us and we will book you in.',
  timetable_unavailable_text: 'We could not check the timetable just now. Please try again in a minute.',
  expect_eyebrow: 'What to expect',
  expect_heading: 'Built for where you are now',
})

export const CAMPAIGN_FUNNEL_EXPECT_CARDS_DEFAULT = Object.freeze([
  { title: 'A coach beside you', body: 'Every movement shown and scaled to you. Never thrown in at the deep end.' },
  { title: 'Strength that lasts', body: 'Bone density, balance and joints. The things that keep you independent.' },
  { title: 'Your own crowd', body: 'The same faces every Monday, Wednesday and Friday. Coffee after, usually.' },
])

// What the page hands the browser. Words and media only.
export const CAMPAIGN_FUNNEL_CLIENT_FIELDS = Object.freeze([
  ...Object.keys(CAMPAIGN_FUNNEL_COPY_DEFAULTS),
  'consent_label', 'expect_cards', 'show_sections', 'video_url', 'poster_url',
])

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** The allow-list, one keyword per line or comma, trimmed lowercase. Same grammar as the deny-list. */
export function parseAllowKeywords(raw) {
  return parseHiddenKeywords(raw)
}

/** The campaign key off a query string or body: slug charset only, lowercase, ≤ 64; null when blank. */
export function resolveCampaignKey(raw) {
  if (raw == null) return null
  const cleaned = String(raw).trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 64)
  return cleaned || null
}

/** The row's campaign_funnel block for exactly this key, or null. */
export function campaignFunnelBlock(blocks, campaign) {
  if (!Array.isArray(blocks) || typeof campaign !== 'string') return null
  return blocks.find((b) => b && typeof b === 'object' && b.type === CAMPAIGN_FUNNEL_TYPE && b.campaign === campaign) || null
}

/**
 * What the routes need off a block: attribution, the trial pair and the
 * allow-list. `configured` is true only with BOTH trial ids.
 */
export function campaignFunnelConfig(block, { landingPath } = {}) {
  const b = block && typeof block === 'object' ? block : {}
  const campaign = str(b.campaign) || ''
  const path = str(landingPath) || 'stillorgan'
  const trialMembershipId = str(b.trial_membership_id)
  const trialPlanCode = str(b.trial_plan_code)
  return {
    campaign,
    tag: str(b.tag) || `${path}-${campaign}`,
    leadSource: str(b.lead_source) || `meta_${campaign}`,
    eventSourceUrl: str(b.event_source_url) || `https://www.un1tdublin.com/${campaign}`,
    trialMembershipId,
    trialPlanCode,
    allowKeywords: parseAllowKeywords(b.class_keywords),
    configured: Boolean(trialMembershipId && trialPlanCode),
  }
}

/**
 * Every customer-facing field resolved: the block's value, else its default
 * (a stored block can predate a field, and an operator can blank one).
 */
export function campaignFunnelCopy(block, { brand = '' } = {}) {
  const b = block && typeof block === 'object' ? block : {}
  const out = {}
  for (const [k, d] of Object.entries(CAMPAIGN_FUNNEL_COPY_DEFAULTS)) out[k] = str(b[k]) || d
  out.consent_label = str(b.consent_label) || classFunnelConsentDefault(brand)
  const cards = Array.isArray(b.expect_cards)
    ? b.expect_cards.filter((c) => c && typeof c === 'object' && str(c.title)).map((c) => ({ title: str(c.title), body: str(c.body) || '' }))
    : []
  out.expect_cards = cards.length > 0 ? cards : CAMPAIGN_FUNNEL_EXPECT_CARDS_DEFAULT.map((c) => ({ ...c }))
  out.show_sections = Array.isArray(b.show_sections)
    ? b.show_sections.filter((s) => CAMPAIGN_FUNNEL_SECTIONS.includes(s))
    : [...CAMPAIGN_FUNNEL_SECTIONS]
  out.video_url = str(b.video_url)
  out.poster_url = str(b.poster_url)
  return out
}

/** The subset of a resolved copy object the browser may see. */
export function campaignFunnelClientCopy(copy) {
  const out = {}
  for (const k of CAMPAIGN_FUNNEL_CLIENT_FIELDS) if (copy && copy[k] !== undefined) out[k] = copy[k]
  return out
}
