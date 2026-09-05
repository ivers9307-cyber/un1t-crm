// EMAIL-TICKET.5 — the sign-off appended to a ticket reply (mig 493).
//
// PLAIN TEXT, ALWAYS. `profiles.email_signature` is a text column with no
// markup path on purpose: a reply is composed as plain text and converted to
// HTML on send, so a signature that could carry markup would be the ONE
// un-sanitised HTML path into outbound mail. The safe shape is therefore
// "append to the TEXT, then convert the whole thing" — callers build the
// signed body with appendSignature() and hand the RESULT to their existing
// text→HTML escaper. Never escape the body and concatenate raw signature
// HTML afterwards; that reintroduces exactly the hole the column type closes.
//
// NEVER on an internal note. A note is written to the thread and sent to
// nobody, so signing it is noise on a staff-only line.
//
// The empty cases are the ones that bite: NULL (nobody has set one), '' (they
// cleared it) and a block of whitespace must all append NOTHING — not a
// dangling separator with nothing under it.

/**
 * RFC 3676 §4.3 signature separator: two hyphens, ONE SPACE, then the line
 * break. The trailing space is not a typo and must not be linted away — it is
 * what Gmail, Apple Mail and Thunderbird key on to collapse a signature out of
 * a quoted reply. A bare "--" line is not the convention and renders as two
 * literal hyphens in the member's mail client.
 */
export const SIGNATURE_SEPARATOR = '-- '

/** Mirrors the profiles_email_signature_len CHECK from mig 493. */
export const MAX_SIGNATURE_LENGTH = 2000

/**
 * The signature exactly as it will be appended, or '' when there is none.
 *
 * CRLF is normalised to LF so a signature pasted out of a mail client doesn't
 * put stray carriage returns into the body, and the whole thing is trimmed so
 * trailing blank lines can't smuggle in an empty-looking-but-present value.
 *
 * @param {string|null|undefined} signature
 * @returns {string}
 */
export function normalizeSignature(signature) {
  if (typeof signature !== 'string') return ''
  return signature.replace(/\r\n?/g, '\n').trim()
}

/**
 * Would this signature add anything at all? The UI uses this to decide
 * whether to show the "this gets added" preview; NULL/''/whitespace are all
 * "no signature".
 *
 * @param {string|null|undefined} signature
 * @returns {boolean}
 */
export function hasSignature(signature) {
  return normalizeSignature(signature).length > 0
}

/**
 * body + blank line + "-- " + signature.
 *
 * Returns the body UNCHANGED when there is no signature — no separator, no
 * trailing newlines, nothing. That is the case that matters: every reply in
 * the system today has no signature, and a stray "--" on all of them would be
 * a visible regression for every member.
 *
 * @param {string} body        the operator's typed reply (already trimmed by
 *                             the route's Zod schema, but not assumed to be)
 * @param {string|null|undefined} signature  profiles.email_signature
 * @returns {string}
 */
export function appendSignature(body, signature) {
  const text = typeof body === 'string' ? body : ''
  const sig = normalizeSignature(signature)
  if (!sig) return text

  // Trailing whitespace on the body would otherwise stack up in front of the
  // blank line and push the separator down the message.
  const trimmed = text.replace(/\s+$/, '')
  if (!trimmed) return `${SIGNATURE_SEPARATOR}\n${sig}`
  return `${trimmed}\n\n${SIGNATURE_SEPARATOR}\n${sig}`
}

// ── MAIL-SIG.1 — the structured rich signature ──────────────────────────
//
// The mig-493 invariant above survives INTACT: the user still never authors
// markup. profiles.email_signature_rich holds FIELDS; this renderer escapes
// every value and assembles the one email-safe HTML block outbound mail may
// carry beyond textToHtml's own output. Callers append `html` AFTER their
// textToHtml conversion (this block is generated here, not user input) and
// `text` under the RFC separator for the plain part.

/** Escape for HTML text/attribute positions. */
function esc(v) {
  return String(v ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

/**
 * The ONLY origins a signature photo may load from — our public branding
 * bucket. Both the write side (/api/me/preferences) and this renderer check
 * it, so a hand-written row cannot point outbound mail at a foreign pixel.
 */
export const SIGNATURE_PHOTO_URL_PREFIXES = Object.freeze([
  'https://iyvtbjjxdggiadzwwvdj.supabase.co/storage/v1/object/public/branding/',
])

export const MAX_SIGNATURE_LINKS = 5

const httpUrl = (u) => typeof u === 'string' && /^https?:\/\//i.test(u.trim()) ? u.trim() : null

/**
 * Audit MAIL-SIG.1 #1 — the prefix is compared on the NORMALIZED URL, so a
 * crafted `/branding/../other-bucket/...` (which the recipient's client
 * normalizes before requesting) cannot slip past a raw startsWith. Exported
 * so the write-side zod refine uses the SAME check — one rule, two gates.
 */
export function isAllowedSignaturePhotoUrl(url) {
  const u = httpUrl(url)
  if (!u) return false
  let normalized
  try { normalized = new URL(u).href } catch { return false }
  return SIGNATURE_PHOTO_URL_PREFIXES.some(p => normalized.startsWith(p))
}

function allowedPhoto(url) {
  return isAllowedSignaturePhotoUrl(url) ? String(url).trim() : null
}

/**
 * The enabled, non-empty rich signature off a profile row — or null, in
 * which case callers keep the legacy plain-text path byte-for-byte.
 */
export function richSignatureFromProfile(profile) {
  const rich = profile?.email_signature_rich
  if (!rich || rich.enabled !== true) return null
  return renderRichSignature(rich) ? rich : null
}

/**
 * Render {text, html} from the structured fields, or null when there is
 * nothing to render. Every value escaped; links http(s)-or-dropped and
 * capped; the photo restricted to our public branding bucket.
 */
export function renderRichSignature(rich) {
  if (!rich || rich.enabled !== true) return null
  const name = String(rich.name ?? '').trim()
  const title = String(rich.title ?? '').trim()
  const phone = String(rich.phone ?? '').trim()
  const note = String(rich.note ?? '').trim()
  const photo = allowedPhoto(rich.photo_url)
  const links = (Array.isArray(rich.links) ? rich.links : [])
    .map(l => ({ label: String(l?.label ?? '').trim(), url: httpUrl(l?.url) }))
    .filter(l => l.url)
    .slice(0, MAX_SIGNATURE_LINKS)

  if (!name && !title && !phone && !note && !photo && links.length === 0) return null

  const textLines = [
    name, [title, note].filter(Boolean).join(' · '), phone,
    ...links.map(l => (l.label ? `${l.label}: ${l.url}` : l.url)),
  ].filter(Boolean)
  const text = textLines.join('\n')

  // ── Design A, "The rule" (Richard's pick, 2 Sep) ─────────────────────
  // Heavy black rule; the name bold, uppercase and letter-spaced like the
  // UN1T wordmark; details in quiet grey; the link row in small caps. The
  // avatar cell shows the profile photo when uploaded, else an INITIALS
  // block — a table cell, not an image, so it renders with zero requests
  // in every client (rounded corners degrade to square in old Outlook,
  // acceptable). Email-safe throughout: one table, inline styles only.
  const initials = name
    ? name.trim().split(/\s+/).slice(0, 2).map(w => w[0].toUpperCase()).join('')
    : ''
  const detail = [title, note].filter(Boolean).join(' · ')

  const rows = []
  if (name) rows.push(`<div style="font-weight:800;font-size:14px;letter-spacing:.08em;text-transform:uppercase;color:#0f172a">${esc(name)}</div>`)
  if (detail) rows.push(`<div style="color:#64748b;font-size:12.5px">${esc(detail)}</div>`)
  if (phone) rows.push(`<div style="color:#64748b;font-size:12.5px">${esc(phone)}</div>`)
  if (links.length) {
    rows.push(`<div style="margin-top:7px;font-size:10.5px;letter-spacing:.12em;text-transform:uppercase">${links.map(l =>
      `<a href="${esc(l.url)}" style="color:#0f172a;font-weight:700;text-decoration:none">${esc(l.label || l.url)}</a>`
    ).join('<span style="color:#cbd5e1"> &nbsp;|&nbsp; </span>')}</div>`)
  }
  const avatarCell = photo
    ? `<td style="vertical-align:top;padding:14px 14px 0 0"><img src="${esc(photo)}" width="56" height="56" alt="" style="border-radius:50%;display:block;object-fit:cover" /></td>`
    : (initials
      ? `<td style="vertical-align:top;padding:14px 14px 0 0"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="width:56px;height:56px;border-radius:50%;background:#0f172a;color:#ffffff;font-weight:800;font-size:18px;letter-spacing:.03em;text-align:center;vertical-align:middle">${esc(initials)}</td></tr></table></td>`
      : '')
  const html =
    `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:18px;border-top:3px solid #0f172a;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:13px;line-height:1.5"><tr>${avatarCell}<td style="vertical-align:top;padding-top:14px">${rows.join('')}</td></tr></table>`

  return { text, html }
}

// ── MAIL-SIG.2 — the studio half of the signature ────────────────────────
//
// The studio-dependent parts follow the account the email LEAVES FROM
// (Richard, 2 Sep: sending from Hatch shows Hatch's links, from Stillorgan
// Stillorgan's). The person always supplies name + photo; the sending
// studio supplies the studio line, and its phone/links when it defines them
// (company_settings.email_signature — the portal-editable home), else the
// person's own profile values stand as the fallback.

/**
 * @param {object|null} personRich  profiles.email_signature_rich
 * @param {{locationName?: string|null, locationSignature?: {phone?, links?}|null}} [ctx]
 * @returns {object|null} the rich signature to render, or null (disabled).
 */
export function effectiveRichSignature(personRich, ctx) {
  if (!personRich || personRich.enabled !== true) return null
  if (!ctx || (!ctx.locationName && !ctx.locationSignature)) return personRich
  const loc = ctx.locationSignature || null
  const locLinks = Array.isArray(loc?.links) ? loc.links.filter(l => l?.url) : []
  const locPhone = typeof loc?.phone === 'string' ? loc.phone.trim() : ''
  return {
    ...personRich,
    note: ctx.locationName || personRich.note,
    phone: locPhone || personRich.phone,
    links: locLinks.length ? locLinks : personRich.links,
  }
}

// ── MAIL-SIGDEFAULT.1 — the studio signature is on for everyone ──────────
//
// Audit finding (mail-arc 09-03): the studio card above was consumed ONLY
// inside effectiveRichSignature, which is only reached through the person's
// own `enabled` flag — so the studio's name/phone/links rendered for NOBODY
// who had not personally opted in, new hires included. profiles.
// email_signature_rich has no column default (mig 582): a fresh profile is
// NULL, and NULL means "send unsigned". Operator decision: default ON, and
// standard for every new user.
//
// FIXED IN CODE, NOT DATA. The two halves are decoupled right here:
//   • the STUDIO block renders whenever the sending studio has configured one
//     (a phone or at least one link on company_settings.email_signature);
//   • the person's `enabled` flag governs only the PERSONAL part — name,
//     title, photo, and their own phone/links as the studio's fallback.
// Zero rows change, so it holds for existing and future users alike, and an
// opted-in person's output is byte-identical to MAIL-SIG.1/2.
//
// resolveSendSignature is THE decision. The three send routes call it, and so
// do the /account preview and the composers' hint (via resolveSignatureHint
// in signature-context.js) — one function, so a preview and a send cannot
// disagree (the whole point of MAILFIX-SIGTRUTH.1).

/**
 * The studio's own block, shaped as a rich signature the renderer already
 * knows how to draw: no name, no photo — the studio line as the detail row,
 * the studio's phone and links. Null when the studio has configured nothing
 * (a studio NAME alone is not a configuration: a "UN1T Stillorgan" line on
 * its own is not a signature anyone asked for).
 *
 * @param {{locationName?: string|null, locationSignature?: {phone?, links?}|null}|null} ctx
 * @returns {object|null}
 */
export function studioRichSignature(ctx) {
  const loc = ctx?.locationSignature || null
  const links = Array.isArray(loc?.links) ? loc.links.filter(l => l?.url) : []
  const phone = typeof loc?.phone === 'string' ? loc.phone.trim() : ''
  if (!phone && links.length === 0) return null
  return {
    enabled: true,
    name: '',
    title: '',
    photo_url: null,
    note: ctx?.locationName || '',
    phone,
    links,
  }
}

/**
 * The plain-text column as an email-safe block for the html part — escaped,
 * line breaks kept (pre-wrap), the same type ramp as the studio table below
 * it. This is generated markup over ESCAPED text, so the mig-493 invariant
 * (the user never authors HTML) survives intact.
 */
function plainSignOffHtml(plain) {
  return `<div style="margin-top:18px;white-space:pre-wrap;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:13px;line-height:1.5;color:#0f172a">${esc(plain)}</div>`
}

/**
 * What a send from the studio described by `ctx` appends for `profile`, as
 * the rich {text, html} block — or NULL when no html block goes out, in
 * which case callers append the plain column exactly as before (which may
 * itself be empty → nothing at all).
 *
 *   1. PERSONAL rich enabled + renderable → the MAIL-SIG.1/2 block, byte for
 *      byte: renderRichSignature(effectiveRichSignature(rich, ctx)). The
 *      plain column stays out of it, as it always has.
 *   2. else the STUDIO block, when the studio has configured one — with the
 *      plain column, when set, as the person's own sign-off ABOVE it. Kept
 *      deliberately: a coach who typed "Sarah / Head Coach" and never opted
 *      in must not lose her name the day the studio block switched on
 *      (CLAUDE.md: removing a silent failure must never create a louder
 *      one). Text = plain, blank line, studio lines; html = escaped plain
 *      block, then the studio table.
 *   3. else null.
 *
 * `hasPhoto`/`hasLinks` describe what the block CARRIES (the hint's suffix
 * line) — the photo only when the renderer would embed it, the links off the
 * EFFECTIVE list.
 *
 * Pure; never throws on a null profile or a null/blipped ctx.
 *
 * @param {{email_signature?: string|null, email_signature_rich?: object|null}|null} profile
 * @param {{locationName?: string|null, locationSignature?: object|null}|null} ctx
 * @returns {{text: string, html: string, hasPhoto: boolean, hasLinks: boolean}|null}
 */
export function resolveSendSignature(profile, ctx) {
  const carries = (rich) => ({
    hasPhoto: isAllowedSignaturePhotoUrl(rich?.photo_url),
    hasLinks: (Array.isArray(rich?.links) ? rich.links : []).filter(l => l?.url).length > 0,
  })

  if (richSignatureFromProfile(profile)) {
    const effective = effectiveRichSignature(profile.email_signature_rich, ctx)
    const rendered = renderRichSignature(effective)
    if (rendered) return { text: rendered.text, html: rendered.html, ...carries(effective) }
  }

  const studio = studioRichSignature(ctx)
  if (studio) {
    const rendered = renderRichSignature(studio)
    if (rendered) {
      const plain = normalizeSignature(profile?.email_signature)
      return {
        text: plain ? `${plain}\n\n${rendered.text}` : rendered.text,
        html: (plain ? plainSignOffHtml(plain) : '') + rendered.html,
        ...carries(studio),
      }
    }
  }

  return null
}
