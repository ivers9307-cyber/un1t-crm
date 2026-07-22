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
  return {
    tag, leadSource, eventSourceUrl,
    trialMembershipId: bothTrial ? trialMembershipId : null,
    trialPlanCode: bothTrial ? trialPlanCode : null,
  }
}
