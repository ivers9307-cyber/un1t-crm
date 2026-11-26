// EMAILUTM.1 — tag links in marketing email that point back at the studio's
// own site with utm_source=email and utm_medium=campaign|automation, so a
// visit (and any lead it creates) from an email reads as email in first-touch
// attribution (contact-first-touch-source.js) and in web analytics.
//
// ONLY utm_source and utm_medium. Every public funnel treats utm_campaign,
// utm_content and utm_term as a META AD signal (campaign-funnel-attribution.js
// buildAttribution: any of them makes the lead ad_provider 'meta'), so adding
// them here would mark email readers as ad leads and could send them to Meta
// as ad conversions. utm_source / utm_medium are measurement only.
//
// Rules, all conservative:
//   - only http(s) links whose host is the studio's own site host (the host
//     of the email's unsubscribe link, which is the tenant site) — third-party
//     links (Instagram, Maps, Glofox) are left alone
//   - never the unsubscribe, preference, view-in-browser or start-prefill
//     pages: those are system links, not marketing
//   - never a link that already carries a utm_source (an operator's own tag
//     wins)
//   - only href="…" / href='…' attributes; merge tags are already filled
//
// Pure string work, no IO. A link that does not parse is left exactly as is.

const SKIP_PATH = /^\/(unsubscribe|preferences|view-email)(\/|$)/

/**
 * @param {string} html
 * @param {{ siteUrl: string|null|undefined, medium: 'campaign'|'automation' }} opts
 * @returns {string}
 */
export function tagOwnSiteLinks(html, { siteUrl, medium }) {
  if (!html || !siteUrl) return html
  let ownHost
  try { ownHost = new URL(siteUrl).host.toLowerCase() } catch { return html }
  if (!ownHost) return html
  return html.replace(/(href\s*=\s*)(["'])(https?:\/\/[^"']+)\2/gi, (whole, pre, quote, raw) => {
    const decoded = raw.replace(/&amp;/g, '&')
    let u
    try { u = new URL(decoded) } catch { return whole }
    if (u.host.toLowerCase() !== ownHost) return whole
    if (SKIP_PATH.test(u.pathname)) return whole
    if (u.searchParams.has('utm_source')) return whole
    u.searchParams.set('utm_source', 'email')
    u.searchParams.set('utm_medium', medium)
    return `${pre}${quote}${u.toString().replace(/&/g, '&amp;')}${quote}`
  })
}

/** The site URL to treat as "own" for an email, from its unsubscribe link. */
export function siteUrlFromUnsubscribe(unsubscribeUrl) {
  if (!unsubscribeUrl) return null
  try { return new URL(unsubscribeUrl).origin } catch { return null }
}
