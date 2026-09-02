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
