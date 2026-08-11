// WEBVIEW.1 — the hosted ("view in browser") copy of a campaign email.
//
// ─── WHY ───────────────────────────────────────────────────────────────────
// Gmail clips a message body over roughly 102KB. It renders what fits, shows
// "[Message clipped]", and hides the rest behind a "View entire message" link
// that opens Gmail's own viewer. What sits at the bottom of a campaign email
// is the FOOTER, and in the footer is the unsubscribe link that
// `appendUnsubscribeFooter` injects. Unlayer designs pass 102KB routinely
// (inline styles, base64 images, table scaffolding), so on a clipped send the
// recipient can see neither the end of the message nor the way out of the
// list. There was no hosted version to fall back to.
//
// ─── THE TOKEN ─────────────────────────────────────────────────────────────
// Stateless HMAC-SHA256 over `{ c: campaignId }`, keyed on
// SUPABASE_SERVICE_ROLE_KEY — the same shape as signHostUnsubToken
// (host-unsubscribe.js) and signCheckinToken (event-checkin-tokens.js), which
// is the established pattern in this repo for a capability URL. Stateless
// means no column, no migration, and no table to keep in step with campaigns.
//
// A raw or sequential campaign id in the URL would be enumerable: anyone could
// walk it and read every campaign this business has ever sent, including
// drafts. The signature makes the URL unguessable without granting anything
// beyond the one campaign it names.
//
// ─── AND WHY THE TOKEN NAMES NO CONTACT ────────────────────────────────────
// This is the PII decision, and it is made here rather than at render time.
//
// The obvious design is to sign `{ campaignId, contactId }` so the hosted copy
// can render the recipient's merge tags and their personal unsubscribe link.
// That would be wrong. A "view in browser" URL is the single most forwarded,
// pasted and screenshotted link in any email: it goes into group chats, into
// support tickets, into "look at this offer" texts. Anything the token can
// resolve is therefore readable by whoever ends up holding it. Binding a
// contact to it turns a forwarded link into a disclosure of that person's
// name, email, phone, pipeline stage and Glofox passcode, and hands the holder
// their working unsubscribe capability too.
//
// So the token names the campaign only, and the merge tags are rendered
// against an EMPTY contact. The hosted copy is byte-identical for every
// recipient and contains no personal data at all, which also means it can be
// cached and is safe to forward on purpose.
//
// The cost is that `{{first_name}}` renders blank ("Hi ,"). That is the same
// thing the send path already does for a contact with no first name, so it is
// not a new rendering path, and it is the right trade: a slightly awkward
// greeting against a personal-data leak to an unauthenticated URL.
//
// Server-only (node:crypto) — never import from a client component.

import crypto from 'node:crypto'
import { applyMergeTags } from './postmark.js'

const b64url = (input) => Buffer.from(input).toString('base64url')

/**
 * Returns null rather than throwing when the secret is absent.
 *
 * Deliberate: signing runs inside the per-recipient render loop in
 * campaign-sender.js. A throw there would fail the whole chunk and mark real
 * recipients as errored, turning a missing environment variable into a failed
 * send. Losing the view-in-browser link is the correct degradation. Matches
 * the repo's "fire-and-forget side effects never fail the primary path" rule.
 */
function getSecret() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || null
}

/**
 * Recipient-facing strings for this feature, in one place.
 *
 * These follow the precedent set by `appendUnsubscribeFooter`, which likewise
 * hard-codes its "Unsubscribe" label: they are system-generated micro-labels
 * on machinery the operator does not author, not campaign copy. Collected here
 * so wiring them to a `company_settings` field later is a one-file change.
 * No em-dashes (customer-copy convention).
 */
export const VIEW_IN_BROWSER_LABEL = 'View this email in your browser'
export const HOSTED_UNSUBSCRIBE_NOTE =
  'This is a web copy of an email. To change what you receive, use the unsubscribe link in the email itself.'

/** Marker so prepend/render stay idempotent without parsing HTML. */
const STRIP_MARKER = 'data-un1t-view-in-browser'
const UNSUB_ANCHOR = 'un1t-hosted-unsubscribe-note'

// Case-insensitive: Unlayer emits `<body ...>` with attributes, and
// hand-authored campaigns have shipped `<BODY>`.
const BODY_OPEN_RE = /<body[^>]*>/i

/**
 * @param {string} campaignId
 * @returns {string|null} `${payload}.${sig}`, both base64url so it is URL-safe
 *   as-is. null when the signing secret is unset (see getSecret).
 */
export function signCampaignViewToken(campaignId) {
  const secret = getSecret()
  if (!secret || !campaignId) return null
  const payload = b64url(JSON.stringify({ c: campaignId }))
  const sig = b64url(crypto.createHmac('sha256', secret).update(payload).digest())
  return `${payload}.${sig}`
}

/**
 * @param {string} token
 * @returns {{campaignId: string}|null} null for anything not well-formed and
 *   signed under the current secret.
 */
export function verifyCampaignViewToken(token) {
  const secret = getSecret()
  if (!secret) return null
  if (typeof token !== 'string' || !token) return null
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [payload, sig] = parts
  if (!payload || !sig) return null
  const expected = b64url(crypto.createHmac('sha256', secret).update(payload).digest())
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  try {
    const obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (!obj || typeof obj !== 'object' || !obj.c) return null
    return { campaignId: obj.c }
  } catch {
    return null
  }
}

/**
 * @param {string} campaignId
 * @param {string} baseUrl  Absolute origin. Required: a relative link in an
 *   email is dead, so return null rather than emit one.
 * @returns {string|null}
 */
export function buildCampaignViewUrl(campaignId, baseUrl) {
  if (!campaignId || !baseUrl) return null
  const token = signCampaignViewToken(campaignId)
  return token ? `${baseUrl}/view-email/${token}` : null
}

/**
 * Insert the view-in-browser strip at the TOP of the message.
 *
 * Top, not bottom, and that placement is the whole feature. Gmail clips from
 * the bottom, so a view-in-browser link in the footer is cut away together
 * with the footer it exists to rescue. Immediately after `<body>` is the first
 * position guaranteed to survive.
 *
 * Idempotent, mirroring `appendUnsubscribeFooter`: the sender re-renders per
 * recipient and a retried row must not accumulate strips.
 *
 * @param {string} html
 * @param {string|null} url
 * @returns {string}
 */
export function prependViewInBrowserLink(html, url) {
  if (!html || !url) return html || ''
  if (html.includes(STRIP_MARKER)) return html

  const strip = `<table ${STRIP_MARKER}="1" role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;"><tr><td align="center" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:7pt;color:#888888;padding:8px;line-height:1.4;"><a href="${url}" style="color:#888888;text-decoration:underline;">${VIEW_IN_BROWSER_LABEL}</a></td></tr></table>`

  const match = html.match(BODY_OPEN_RE)
  if (!match) return strip + html
  const at = match.index + match[0].length
  return html.slice(0, at) + strip + html.slice(at)
}

/**
 * Render the hosted copy of a campaign's HTML.
 *
 * Merge tags resolve against an EMPTY contact, so no recipient data can appear
 * even if the design inlines `{{email}}` — see the module header for why the
 * token deliberately carries no contact. `{{location_name}}` and
 * `{{current_year}}` still resolve: they are properties of the sender and the
 * clock, not of a person.
 *
 * `{{unsubscribe_url}}` / `{{preference_url}}` cannot be personalised without
 * a contact, so they point at an in-page note rather than an empty href, which
 * would render as a dead link on the very page a clipped recipient reached
 * because they could not find the real one.
 *
 * @param {object} campaign  A campaigns row, optionally with `locations(name)`.
 * @param {{ baseUrl?: string }} [opts]
 * @returns {string|null} null when there is nothing to show.
 */
export function renderCampaignWebView(campaign, opts = {}) {
  const html = campaign?.html_content
  if (!html) return null

  // Every field applyMergeTags reads off a contact, explicitly blank. Spelled
  // out rather than passing `{}` so that a merge tag added to postmark.js in
  // future fails loudly in review here instead of silently rendering.
  const anonymousContact = {
    first_name: '', last_name: '', name: '', email: '', phone: '',
    pipeline_stage_slug: '', glofox_passcode: '',
  }

  const merged = applyMergeTags(html, anonymousContact, {
    location_name: campaign?.locations?.name || '',
    unsubscribe_url: `#${UNSUB_ANCHOR}`,
    preference_url: `#${UNSUB_ANCHOR}`,
  })

  const note = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;"><tr><td id="${UNSUB_ANCHOR}" align="center" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:7pt;color:#888888;padding:16px 8px;line-height:1.4;">${HOSTED_UNSUBSCRIBE_NOTE}</td></tr></table>`

  const closing = merged.toLowerCase().lastIndexOf('</body>')
  const withNote = closing === -1
    ? merged + note
    : merged.slice(0, closing) + note + merged.slice(closing)

  // Deliberately NOT prependViewInBrowserLink: this IS the browser copy, and a
  // "view in browser" link pointing at the page you are already on is noise.
  void opts
  return withNote
}
