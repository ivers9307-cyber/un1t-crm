// PAGES.1 — the pure helpers of the page editor's save (LandingPageSettingsForm
// in page mode): what chrome is sent back, the studio page's terms copy, the
// snapshot that says whether anything changed since the last save, and the
// words for a refused save. No IO; client-safe.

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

// Everything the page-mode Save sends, as one string: unequal to the last
// saved snapshot means there are unsaved edits.
export function pageEditSnapshot({ title, blocks, logoUrl, logoAlt, logoWidthPx, showInstagramFeed, terms }) {
  return JSON.stringify({ title, blocks, logoUrl, logoAlt, logoWidthPx, showInstagramFeed, terms })
}

export const PAGE_SAVE_MESSAGES = Object.freeze({
  offer_block_required: 'The offer section must stay first on this page.',
  studio_page: 'This studio page is edited from the Landing page editor until studio pages move here.',
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
