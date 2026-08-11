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
 * Recipient-facing strings for this feature.
 *
 * K7 — these were hard-coded, against the standing invariant that
 * customer-facing copy is operator-editable with a default fallback. They are
 * now the DEFAULTS behind two nullable `company_settings` columns (mig 530),
 * resolved per location by `resolveEmailCopy` below. NULL means "use the
 * default", so a location that never opens the settings card behaves exactly
 * as it did before and no backfill is needed.
 *
 * The strings themselves are unchanged. No em-dashes (customer-copy
 * convention), low-key and factual.
 */
export const DEFAULT_VIEW_IN_BROWSER_LABEL = 'View this email in your browser'
export const DEFAULT_HOSTED_COPY_NOTE =
  'This is a web copy of an email. To change what you receive, use the unsubscribe link in the email itself.'

/** The company_settings column names (mig 530), in one place. */
export const EMAIL_COPY_COLUMNS = Object.freeze({
  viewInBrowserLabel: 'view_in_browser_label',
  hostedCopyNote: 'hosted_copy_note',
})

/** The resolved shape, with both defaults applied. */
export const DEFAULT_EMAIL_COPY = Object.freeze({
  viewInBrowserLabel: DEFAULT_VIEW_IN_BROWSER_LABEL,
  hostedCopyNote: DEFAULT_HOSTED_COPY_NOTE,
})

/**
 * Escape operator-authored copy before it goes into HTML.
 *
 * These strings land in a public page AND in every recipient's inbox, so they
 * are interpolated into markup, not rendered by React. An operator typing an
 * ampersand or an angle bracket must not be able to break the surrounding
 * table out of shape, let alone inject a tag. The defaults contain nothing
 * that escapes, so this changes no existing output.
 */
function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * Resolve the per-location copy, falling back to the defaults.
 *
 * Mirrors `normalizeQuietHours` (src/lib/send-quiet-hours.js), the repo's
 * precedent for an operator-editable company_settings value: accepts the row
 * shape (snake_case columns), the camelCase shape the client hands back, or
 * null for "no row at all", and falls back per FIELD rather than per object so
 * a half-written row can never blank one of the two strings.
 *
 * A whitespace-only value is treated as unset. An operator who clears the box
 * means "go back to the default", not "ship an empty link label" — an empty
 * `<a></a>` is an invisible, unclickable view-in-browser link, which is the
 * exact failure this feature exists to prevent.
 *
 * @param {object|null} raw
 * @returns {{ viewInBrowserLabel: string, hostedCopyNote: string }}
 */
export function resolveEmailCopy(raw) {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_EMAIL_COPY }
  const pick = (column, camel, fallback) => {
    const value = raw[column] ?? raw[camel]
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
  }
  return {
    viewInBrowserLabel: pick(
      EMAIL_COPY_COLUMNS.viewInBrowserLabel, 'viewInBrowserLabel', DEFAULT_VIEW_IN_BROWSER_LABEL,
    ),
    hostedCopyNote: pick(
      EMAIL_COPY_COLUMNS.hostedCopyNote, 'hostedCopyNote', DEFAULT_HOSTED_COPY_NOTE,
    ),
  }
}

/**
 * Read a location's email copy off company_settings.
 *
 * Best-effort by design, matching getSecret() above: this runs on the send
 * path, and a settings read that hiccups must degrade to the default copy
 * rather than fail a campaign. No row is the NORMAL case (most locations have
 * never saved branding), which is why it is not treated as an error.
 *
 * @param {object} db  service-role client
 * @param {string} locationId
 */
export async function fetchLocationEmailCopy(db, locationId) {
  if (!db || !locationId) return { ...DEFAULT_EMAIL_COPY }
  try {
    const { data, error } = await db
      .from('company_settings')
      .select(`${EMAIL_COPY_COLUMNS.viewInBrowserLabel}, ${EMAIL_COPY_COLUMNS.hostedCopyNote}`)
      .eq('location_id', locationId)
      .limit(1)
    if (error) return { ...DEFAULT_EMAIL_COPY }
    return resolveEmailCopy((data && data[0]) || null)
  } catch {
    return { ...DEFAULT_EMAIL_COPY }
  }
}

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
 * @param {object|null} [copy]  resolved or raw company_settings copy (K7);
 *   omit for the defaults.
 * @returns {string}
 */
export function prependViewInBrowserLink(html, url, copy = null) {
  if (!html || !url) return html || ''
  if (html.includes(STRIP_MARKER)) return html

  const label = escapeHtml(resolveEmailCopy(copy).viewInBrowserLabel)
  const strip = `<table ${STRIP_MARKER}="1" role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;"><tr><td align="center" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:7pt;color:#888888;padding:8px;line-height:1.4;"><a href="${url}" style="color:#888888;text-decoration:underline;">${label}</a></td></tr></table>`

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
 * @param {{ baseUrl?: string, copy?: object|null }} [opts]  `copy` is the
 *   location's company_settings copy (K7); omit for the defaults.
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

  const hostedCopyNote = escapeHtml(resolveEmailCopy(opts?.copy).hostedCopyNote)
  const note = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;"><tr><td id="${UNSUB_ANCHOR}" align="center" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:7pt;color:#888888;padding:16px 8px;line-height:1.4;">${hostedCopyNote}</td></tr></table>`

  const closing = merged.toLowerCase().lastIndexOf('</body>')
  const withNote = closing === -1
    ? merged + note
    : merged.slice(0, closing) + note + merged.slice(closing)

  // Deliberately NOT prependViewInBrowserLink: this IS the browser copy, and a
  // "view in browser" link pointing at the page you are already on is noise.
  void opts
  return withNote
}
