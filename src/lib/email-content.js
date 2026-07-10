// COMMS-AUDIT 2026-07-10 — email content helpers (CAMPAIGN-REL.3/.4).
//
// Two pure, dependency-free helpers shared by the email send paths:
//
//   htmlToPlainText — conservative HTML → plain-text conversion so
//     every email ships with a TextBody alternative. HTML-only
//     multipart is a known spam signal; a coherent text part that
//     matches the HTML scores better with Gmail/Outlook filters and
//     keeps the email readable in text-only clients. This is a
//     STRIPPER, not a layout engine: block tags become newlines,
//     anchors keep their targets, everything else is dropped.
//
//   injectPreheader — inserts campaigns.preview_text as the standard
//     hidden-preheader pattern (invisible div, first thing inside
//     <body>) so inbox list views show the operator's chosen snippet
//     instead of whatever text happens to render first.
//
// Both are deliberately in their own module (not postmark.js) to keep
// postmark.js surgical — several parallel workstreams touch it.

/**
 * Convert an HTML email body to a conservative plain-text alternative.
 *
 * Rules:
 *  - <head>/<style>/<script> blocks are dropped wholesale.
 *  - <br> and closing block tags (p/div/tr/table/h1-6/li/ul/ol/
 *    blockquote) become newlines; <li> gets a "- " bullet.
 *  - <a href="...">label</a> becomes "label (href)" so links stay
 *    actionable; when the label IS the href (or empty) the URL is
 *    emitted once. mailto: labels are kept as-is.
 *  - Common entities are decoded; whitespace is collapsed per line
 *    and blank-line runs squeezed.
 *
 * @param {string} html
 * @returns {string} plain text ('' for falsy input)
 */
export function htmlToPlainText(html) {
  if (!html) return ''
  let s = String(html)

  // Drop non-content blocks entirely.
  s = s.replace(/<head[\s\S]*?<\/head>/gi, ' ')
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ')
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ')
  s = s.replace(/<!--[\s\S]*?-->/g, ' ')

  // Anchors: keep the destination. Tracking-wrapped links still point
  // somewhere useful, and an unsubscribe link that vanishes from the
  // text part is a compliance problem.
  s = s.replace(/<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, inner) => {
    const label = inner.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
    if (!href) return ` ${label} `
    if (!label || label === href) return ` ${href} `
    if (href.toLowerCase().startsWith('mailto:')) return ` ${label} `
    return ` ${label} (${href}) `
  })

  // Structure → newlines.
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<li\b[^>]*>/gi, '\n- ')
  s = s.replace(/<\/(p|div|td|tr|table|h[1-6]|li|ul|ol|blockquote|section|article|header|footer)>/gi, '\n')

  // Everything else goes.
  s = s.replace(/<[^>]+>/g, ' ')

  // Decode the entity set that actually appears in our templates.
  s = s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&zwnj;|&#8204;|&#847;/gi, '')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')

  // Collapse: spaces/tabs within lines, trim each line, squeeze blank runs.
  s = s.replace(/[ \t]+/g, ' ')
  s = s
    .split('\n')
    .map(line => line.trim())
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .trim()

  return s
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Inject preview/preheader text as the first element inside <body>.
 *
 * Uses the belt-and-braces hidden-element CSS set (display:none alone
 * is ignored by Outlook — hence mso-hide, max-height:0, overflow:
 * hidden, opacity:0) plus a run of &nbsp;&zwnj; padding so clients
 * that truncate at the preheader don't bleed body copy into the
 * inbox snippet.
 *
 * The preview text is operator-entered PLAIN text — it is HTML-escaped
 * here, never interpreted.
 *
 * @param {string} html — fully rendered email body
 * @param {string} previewText — plain-text preheader
 * @returns {string}
 */
export function injectPreheader(html, previewText) {
  if (!html || !previewText) return html

  const padding = '&nbsp;&zwnj;'.repeat(30)
  const preheader =
    `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">` +
    `${escapeHtml(previewText)}${padding}</div>`

  // First <body ...> tag (case-insensitive, attributes allowed).
  const bodyOpen = html.match(/<body\b[^>]*>/i)
  if (!bodyOpen) return preheader + html
  const insertAt = bodyOpen.index + bodyOpen[0].length
  return html.slice(0, insertAt) + preheader + html.slice(insertAt)
}
