// Public landing pages are addressed by a URL-safe `public_path` slug
// (e.g. 'stillorgan', 'hatch-street') that maps 1:1 to a
// landing_page_settings row → location_id. Public funnel endpoints take
// this slug from the client; this helper sanitises it and defaults to
// Stillorgan (the original hard-coded target) so pre-existing callers
// that send no path keep working.
const DEFAULT_LANDING_PATH = 'stillorgan'

export function resolveLandingPath(raw) {
  if (raw == null) return DEFAULT_LANDING_PATH
  const cleaned = String(raw)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '') // slug charset only — never trust the client
    .slice(0, 64)
  return cleaned || DEFAULT_LANDING_PATH
}

// The class_funnel block's nurture attribution: the tag stamped on the captured
// lead, its lead_source, and the Meta CAPI eventSourceUrl. Derived from the
// resolved location's landing_page_settings.blocks (mirrors leadConfigFromBlocks
// in leads.js) so a second gym adopting the block gets its OWN attribution
// instead of Stillorgan's literals. The client never sends these, so they can't
// be injected.
//
// Defaults are location-DERIVED, not hard-coded, so the block is correct-by-
// default for any location with no operator action — yet reproduce today's live
// Stillorgan /start values byte-for-byte:
//   - tag            → `${landingPath}-start`  ⇒ 'stillorgan-start'
//   - lead_source    → 'meta_book'             (funnel-generic, not location-specific)
//   - eventSourceUrl → the funnel's real public URL. Stillorgan's funnel lives at
//     the paid /start page (NOT /stillorgan), so it's special-cased; every other
//     path defaults to /{public_path}.
// An operator can still override any of the three via the class_funnel block's
// tag / lead_source / event_source_url fields (passthrough-persisted — see
// BlockBaseSchema in landing-page-blocks.js).
const DEFAULT_CLASS_FUNNEL_LEAD_SOURCE = 'meta_book'
const CLASS_FUNNEL_EVENT_SOURCE_URL_BY_PATH = {
  stillorgan: 'https://www.un1tdublin.com/start',
}

export function classFunnelConfigFromBlocks(blocks, landingPath) {
  const path = resolveLandingPath(landingPath)
  const list = Array.isArray(blocks) ? blocks : []
  const cf = list.find((b) => b && typeof b === 'object' && b.type === 'class_funnel')
  const override = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  const tag = override(cf?.tag) || `${path}-start`
  const leadSource = override(cf?.lead_source) || DEFAULT_CLASS_FUNNEL_LEAD_SOURCE
  const eventSourceUrl = override(cf?.event_source_url)
    || CLASS_FUNNEL_EVENT_SOURCE_URL_BY_PATH[path]
    || `https://www.un1tdublin.com/${path}`
  // Per-funnel trial product override — BOTH ids must be present to count;
  // a half-configured block (only one set) falls back to the location default.
  const trialMembershipId = override(cf?.trial_membership_id)
  const trialPlanCode = override(cf?.trial_plan_code)
  const bothTrial = trialMembershipId && trialPlanCode
  const rawPrice = Number(cf?.price_cents)
  const priceCents = Number.isFinite(rawPrice) && rawPrice > 0 ? Math.floor(rawPrice) : 0
  const currency = (typeof cf?.currency === 'string' && cf.currency.trim()) ? cf.currency.trim().toUpperCase() : 'EUR'
  return {
    tag, leadSource, eventSourceUrl,
    trialMembershipId: bothTrial ? trialMembershipId : null,
    trialPlanCode: bothTrial ? trialPlanCode : null,
    priceCents, currency,
  }
}

// REGISTRYREAD.1a — what the class funnel tells a customer when the timetable
// could not be read (a settings-read blip or Glofox not answering), so the
// booking was not taken. Customer copy is operator-editable (CLAUDE.md): the
// class_funnel block's `timetable_unavailable_message` field, edited in the
// landing-page editor, with this default when it is blank or absent. Same
// block + override rule as classFunnelConfigFromBlocks. Deliberately NOT
// seeded into new blocks, so a later change to the default reaches every
// funnel nobody has customised. No em-dashes in customer copy.
export const DEFAULT_TIMETABLE_UNAVAILABLE_MESSAGE =
  'We could not check the timetable just now. Please try again in a minute.'

export function classFunnelTimetableUnavailableMessage(blocks) {
  const list = Array.isArray(blocks) ? blocks : []
  const cf = list.find((b) => b && typeof b === 'object' && b.type === 'class_funnel')
  const v = cf?.timetable_unavailable_message
  return (typeof v === 'string' && v.trim()) ? v.trim() : DEFAULT_TIMETABLE_UNAVAILABLE_MESSAGE
}

// MANUALFUNNEL.1 — the label on every "scroll to the funnel" button (the
// sticky header, the section CTAs, the footer) for a page whose capture is a
// class funnel. Operator-editable: the class_funnel block's `cta_label`,
// edited in the landing-page editor. The default is the label /stillorgan
// has always shown, so a block nobody has customised renders as before.
export const DEFAULT_CLASS_FUNNEL_CTA_LABEL = 'Claim 3 free classes'

export function classFunnelCtaLabel(blocks) {
  const list = Array.isArray(blocks) ? blocks : []
  const cf = list.find((b) => b && typeof b === 'object' && b.type === 'class_funnel')
  const v = cf?.cta_label
  return (typeof v === 'string' && v.trim()) ? v.trim() : DEFAULT_CLASS_FUNNEL_CTA_LABEL
}

// MANUALFUNNEL.1 — a class_funnel block can be kept OFF the studio's main
// landing page (`show_on_landing: false`) while still configuring its
// dedicated page at /start/{path}. Absent or anything but an explicit false
// shows it, which is every block saved before the switch existed.
export function classFunnelShownOnLanding(block) {
  return !!block && block.type === 'class_funnel' && block.show_on_landing !== false
}
