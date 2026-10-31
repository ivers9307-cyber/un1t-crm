// PAGES.1 — the pure helpers of the page editor's saves: the page body
// LandingPageSettingsForm sends (pageSaveBody: what chrome goes back, the
// studio page's terms copy), the body a studio row sends (studioRowSaveBody,
// StudioOfferRow), the snapshot that says whether anything changed since the
// last save, and the words for a refused save. No IO; client-safe. The two
// builders are the ones the editor calls, so page-save.schema.test.js parses
// exactly what is sent against the routes' schemas.

import { DEFAULT_FUNNEL_TERMS_COPY } from '@/lib/un1t-online-funnel-copy'

// The chrome keys a page's PUT accepts (landingPageChromeSchema), less
// was_live: the stored chrome is sent back through storedChrome so a key the
// schema does not know never fails the save.
export const PAGE_CHROME_KEYS = Object.freeze([
  'logo_url', 'logo_alt', 'logo_width_px', 'tone', 'noindex', 'meta_title', 'meta_description',
  'show_instagram_feed', 'chooser_label', 'chooser_cta_text', 'chooser_image_url', 'un1t_terms',
])

export function storedChrome(chrome) {
  const out = {}
  if (!chrome || typeof chrome !== 'object') return out
  for (const key of PAGE_CHROME_KEYS) if (chrome[key] !== undefined) out[key] = chrome[key]
  return out
}

// A studio page's un1t.online terms copy: each field trimmed, blank = null
// (the funnel then uses DEFAULT_FUNNEL_TERMS_COPY).
export function termsForSave(terms) {
  const out = {}
  for (const key of Object.keys(DEFAULT_FUNNEL_TERMS_COPY)) {
    const v = typeof terms?.[key] === 'string' ? terms[key].trim() : ''
    out[key] = v || null
  }
  return out
}

/** The logo width as saved: the typed string read as a whole number, clamped to 40-600 (the schema's range); blank or junk = null. */
export function logoWidthForSave(raw) {
  const parsed = parseInt(raw, 10)
  return Number.isFinite(parsed) ? Math.min(600, Math.max(40, parsed)) : null
}

/**
 * The body of PUT /api/landing-pages/<id>: the title trimmed, the blocks as
 * the editor holds them, and the stored chrome with the form's logo and
 * Instagram fields over it (was_live is the server's, never sent). A studio
 * page also sends its un1t.online terms copy (the editor shows those fields
 * on a studio page only) as chrome.un1t_terms.
 */
export function pageSaveBody({ page, title, blocks, logoUrl, logoAlt, logoWidthPx, showInstagramFeed, terms }) {
  const chrome = {
    ...storedChrome(page?.chrome),
    logo_url: (logoUrl || '').trim() || null,
    logo_alt: (logoAlt || '').trim() || null,
    logo_width_px: logoWidthForSave(logoWidthPx),
    show_instagram_feed: Boolean(showInstagramFeed),
  }
  if (page?.kind === 'studio') chrome.un1t_terms = termsForSave(terms)
  return { title: (title || '').trim(), blocks, chrome }
}

/** A studio row's tag and lead source as the form edits them (strings). */
export function attributionDraft(attribution) {
  return {
    tag: typeof attribution?.tag === 'string' ? attribution.tag : '',
    lead_source: typeof attribution?.lead_source === 'string' ? attribution.lead_source : '',
  }
}

/**
 * The attribution a studio row's save sends: the non-blank tag and lead
 * source (blank = use the default). A stored Meta page URL, which the row
 * does not edit, goes back unchanged so a save never drops it.
 */
export function attributionToSend(draft, stored) {
  const out = {}
  for (const key of ['tag', 'lead_source']) {
    const v = (draft?.[key] || '').trim()
    if (v) out[key] = v
  }
  if (typeof stored?.event_source_url === 'string' && stored.event_source_url) out.event_source_url = stored.event_source_url
  return out
}

/** The body of PUT /api/landing-pages/<id>/studios/<locationId> (landingPageStudioSchema). */
export function studioRowSaveBody({ enabled, offer, attribution, storedAttribution }) {
  return {
    enabled: Boolean(enabled),
    offer: offer && typeof offer === 'object' ? offer : {},
    attribution: attributionToSend(attribution, storedAttribution),
  }
}

// Everything the page-mode Save sends, as one string: unequal to the last
// saved snapshot means there are unsaved edits.
export function pageEditSnapshot({ title, blocks, logoUrl, logoAlt, logoWidthPx, showInstagramFeed, terms }) {
  return JSON.stringify({ title, blocks, logoUrl, logoAlt, logoWidthPx, showInstagramFeed, terms })
}

export const PAGE_SAVE_MESSAGES = Object.freeze({
  offer_block_required: 'This page\'s offer section is missing, so it cannot be saved. Ask the team.',
  studio_page: 'A studio page keeps its path: it is the studio\'s address.',
  reserved: 'That path is reserved.',
  taken: 'That path is already taken.',
  invalid: 'Use letters, numbers and dashes only, 2 to 40 characters.',
  unavailable: 'The page could not be reached. Try again in a minute.',
})

/** The words for a refused page save: the first field validation named, else the API's code in words. */
export function pageSaveMessage(body, status) {
  const issue = Array.isArray(body?.issues) ? body.issues[0] : null
  if (issue?.path) return `Invalid value for ${issue.path}`
  return PAGE_SAVE_MESSAGES[body?.error] || body?.error || `Save failed (${status})`
}
