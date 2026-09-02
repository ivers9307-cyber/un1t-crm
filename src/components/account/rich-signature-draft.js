// MAIL-SIG.1 — pure draft model for the rich-signature editor on /account.
//
// Everything branchable lives here, tested in rich-signature-draft.test.js;
// RichSignatureEditor.jsx stays a thin shell over it. The contract on the
// other side is /api/me/preferences' strict zod schema — the caps and the
// payload shape here mirror it exactly so a server 400 is the rare path
// (and when one does happen, the component surfaces the server's words).
//
// Client-safe on purpose: imports only the shared renderer, which is pure.

import { MAX_SIGNATURE_LINKS, renderRichSignature } from '@/lib/email-signature'

/** Mirrors the zod caps in /api/me/preferences — drift = avoidable 400s. */
export const RICH_FIELD_CAPS = Object.freeze({
  name: 120,
  title: 120,
  phone: 60,
  note: 200,
  link_label: 40,
  link_url: 300,
})

/** Mirrors POST /api/me/signature-photo's ALLOWED map + MAX_BYTES. */
export const PHOTO_ACCEPT = 'image/jpeg,image/png,image/webp'
export const PHOTO_MAX_BYTES = 2 * 1024 * 1024

export function emptyRichDraft() {
  return { enabled: false, name: '', title: '', phone: '', note: '', photo_url: null, links: [] }
}

/**
 * A saved profiles.email_signature_rich value (or null) → an editable draft.
 * Always returns fresh objects — the caller mutates the draft freely without
 * touching whatever the server page handed down.
 */
export function richDraftFromSaved(saved) {
  const base = emptyRichDraft()
  if (!saved || typeof saved !== 'object') return base
  return {
    enabled: saved.enabled === true,
    name: typeof saved.name === 'string' ? saved.name : '',
    title: typeof saved.title === 'string' ? saved.title : '',
    phone: typeof saved.phone === 'string' ? saved.phone : '',
    note: typeof saved.note === 'string' ? saved.note : '',
    photo_url: typeof saved.photo_url === 'string' && saved.photo_url ? saved.photo_url : null,
    links: (Array.isArray(saved.links) ? saved.links : []).map((l) => ({
      label: typeof l?.label === 'string' ? l.label : '',
      url: typeof l?.url === 'string' ? l.url : '',
    })),
  }
}

/** Both halves blank — the row is dropped at save, never an error. */
export function isEmptyLinkRow(row) {
  return !(row?.label ?? '').trim() && !(row?.url ?? '').trim()
}

/**
 * Full-URL http(s) check, mirroring the server's z.string().url() +
 * /^https?:/ refine — `new URL` rejects what zod rejects ('https://' alone,
 * bare words), and the protocol check drops javascript:/ftp:/etc.
 */
function isHttpUrl(value) {
  const v = (value ?? '').trim()
  if (!/^https?:\/\//i.test(v)) return false
  try {
    const u = new URL(v)
    return Boolean(u.hostname)
  } catch {
    return false
  }
}

/**
 * null when the row is fine (or empty → dropped); a human message when the
 * server would 400 it.
 */
export function linkRowError(row) {
  if (isEmptyLinkRow(row)) return null
  const url = (row?.url ?? '').trim()
  if (!url) return 'Add a URL for this link'
  if (!isHttpUrl(url)) return 'Enter a full http:// or https:// URL'
  return null
}

export function canAddLink(links) {
  return (Array.isArray(links) ? links.length : 0) < MAX_SIGNATURE_LINKS
}

/**
 * Per-row errors keyed by index (empty rows excluded), plus an overall
 * validity flag — the Save button gates on it.
 */
export function richDraftErrors(draft) {
  const links = {}
  let valid = true
  ;(draft?.links ?? []).forEach((row, i) => {
    const err = linkRowError(row)
    if (err) {
      links[i] = err
      valid = false
    }
  })
  return { valid, links }
}

/**
 * The exact object PATCH /api/me/preferences receives as
 * email_signature_rich: strings trimmed, empty link rows dropped, the link
 * count capped, photo_url null-or-url. Key order is fixed so
 * payloadsEqual's stringify comparison is stable.
 */
export function buildRichPayload(draft) {
  const d = draft ?? {}
  return {
    enabled: d.enabled === true,
    name: (d.name ?? '').trim(),
    title: (d.title ?? '').trim(),
    phone: (d.phone ?? '').trim(),
    note: (d.note ?? '').trim(),
    photo_url: typeof d.photo_url === 'string' && d.photo_url ? d.photo_url : null,
    links: (Array.isArray(d.links) ? d.links : [])
      .filter((row) => !isEmptyLinkRow(row))
      .slice(0, MAX_SIGNATURE_LINKS)
      .map((row) => ({ label: (row.label ?? '').trim(), url: (row.url ?? '').trim() })),
  }
}

/** Dirty check — compare buildRichPayload() outputs, never raw drafts. */
export function payloadsEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Client-side pre-check mirroring the upload route, so the round trip is
 * saved for the obvious rejects. The server remains the authority.
 */
export function photoFileError(file) {
  if (!file) return 'Choose a photo'
  if (!PHOTO_ACCEPT.split(',').includes(file.type)) return 'Photo must be JPEG, PNG or WebP'
  if (file.size > PHOTO_MAX_BYTES) return 'Photo must be under 2MB'
  return null
}

/**
 * The srcDoc for the sandboxed preview iframe — the SHARED renderer's html
 * (so the preview can never drift from what outbound mail carries) inside a
 * minimal email-foot shell. Renders the draft as it WOULD send (enabled
 * forced on, so drafting previews before the toggle is committed); null when
 * there is nothing to render.
 */
export function richPreviewSrcDoc(payload) {
  const rendered = renderRichSignature({ ...payload, enabled: true })
  if (!rendered) return null
  return (
    '<!doctype html><html><head><meta charset="utf-8"></head>' +
    '<body style="margin:0;padding:16px;background:#ffffff;color:#0f172a;' +
    "font-family:-apple-system,'Segoe UI',sans-serif;font-size:13px\">" +
    '<div style="color:#94a3b8">&hellip;the end of your email</div>' +
    rendered.html +
    '</body></html>'
  )
}
