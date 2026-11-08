// HOSTSTATS.1 — tag a host campaign's event links with `hc=<campaign id>`.
//
// A booking made from a host's email is otherwise indistinguishable from a
// direct visit. After the campaign is rendered (and so after the body has
// been sanitised), every <a href> whose URL sits on the TENANT host and whose
// path starts /event/ or /h/ gets `hc=<campaign id>` (an existing hc is
// replaced, an existing query is joined). The signup page reads `hc` into the
// tab's first-touch attribution and the server proves it against the event's
// host before counting it as `host_email`. Nothing else in the document is
// touched: another host's site, the unsubscribe link, images, mailto.
//
// Spans come from the same tokenizer the sanitizer trusts (markupTagSpans),
// so quoting, spacing and case cannot hide a link, and a tagged value is
// written back double-quoted and attribute-escaped.

import { markupTagSpans } from '@/lib/host-campaign-email'

const TAGGED_PATH = /^\/(event|h)\//

function decodeAttr(v) {
  return String(v)
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}
function encodeAttr(v) {
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * @param {string} html the rendered campaign
 * @param {{ campaignId: string|null, tenantHost: string|null }} opts
 * @returns {string} the same string when nothing applies or matches
 */
export function tagHostCampaignLinks(html, { campaignId, tenantHost } = {}) {
  const src = String(html ?? '')
  if (!campaignId || !tenantHost) return src
  const host = String(tenantHost).toLowerCase()
  const edits = []
  for (const tag of markupTagSpans(src)) {
    if (tag.isEnd || tag.name !== 'a') continue
    for (const a of tag.attrs) {
      if (a.valueStart < 0) continue
      if (src.slice(a.nameStart, a.nameEnd).toLowerCase() !== 'href') continue
      const raw = decodeAttr(src.slice(a.valueStart, a.valueEnd)).trim()
      let url
      try { url = new URL(raw) } catch { continue }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue
      if (url.host.toLowerCase() !== host || !TAGGED_PATH.test(url.pathname)) continue
      url.searchParams.set('hc', campaignId)
      edits.push({ start: a.valueOuterStart, end: a.end, text: `"${encodeAttr(url.toString())}"` })
    }
  }
  if (edits.length === 0) return src
  let out = src
  for (const e of edits.sort((x, y) => y.start - x.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end)
  return out
}
