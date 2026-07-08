// EVENTS-EMAILCFG.1 — the shared branded shell + per-event resolution for the
// standalone events-platform emails (signup CONFIRMATION + pre-event REMINDER).
//
// Two entry points:
//   buildEventEmailShell(...) — the branded HTML skeleton. With accentHex /
//     headerImageUrl null it reproduces TODAY's look byte-for-byte (black #000
//     "UN1T" header). accentHex recolours the header; headerImageUrl swaps in a
//     banner-image header. Every scalar it interpolates (member names, location)
//     is HTML-escaped; the *Html slots (heading/introHtml/infoRows/afterInfoHtml/
//     footerHtml) are raw fragments the caller has ALREADY escaped.
//   resolveEventEmail(...) — applies the per-event precedence for one email:
//     1. race[<kind>_email_template_id] set → render that email_templates row's
//        html_content with merge tags; subject = race[<kind>_email_subject] ||
//        the current default subject.
//     2. else → the shared shell, tinted by the event's accent_hex/hero_image_url,
//        with race[<kind>_email_intro] copy dropped into the "what's next" block
//        (falling back to the caller's default copy when blank).
//
// Merge tags available in copy + templates: the standard applyMergeTags contact
// tags PLUS {{event_name}}, {{team_name}}, {{when}}, {{location}}.
//
// LIVE EMAILS: with no per-event config (all columns NULL) the shell output is
// identical to the pre-refactor builders — locked by event-email.test.js.

import { applyMergeTags } from '@/lib/postmark'
import { logWarn } from '@/lib/log'

// Mirrors the strict per-event accent validation the public signup widget uses
// (RaceSignupWidget) — only a literal #rrggbb can ever reach an inline style.
const HEX_RE = /^#[0-9a-fA-F]{6}$/

/**
 * HTML-escape a scalar for safe interpolation. Identical to the local escapers
 * the two senders previously carried (kept here as the single copy).
 */
export function escapeHtml(s) {
  if (s == null) return ''
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

// ============================================================
// MERGE TAGS — event extras on top of the standard contact tags
// ============================================================

/**
 * Plain-text merge (for the SUBJECT line, which is not HTML). Reuses the
 * standard applyMergeTags contact tags and adds the event extras.
 */
export function applyEventMergeTags(text, contact, extras = {}) {
  if (!text) return text
  let out = applyMergeTags(text, contact || {}, { location_name: extras.location || '' })
  out = out.replaceAll('{{event_name}}', extras.event_name || '')
  out = out.replaceAll('{{team_name}}', extras.team_name || '')
  out = out.replaceAll('{{when}}', extras.when || '')
  out = out.replaceAll('{{location}}', extras.location || '')
  return out
}

/**
 * HTML-context merge (for a full-HTML template body). The operator's own
 * html_content is inserted verbatim, but every merge VALUE (contact + event
 * fields — names, team names, locations are attacker-influenced) is escaped so
 * a crafted name can't inject markup. This is stricter than the sibling
 * booking-confirmations template path, in line with the events security bar.
 */
export function applyEventMergeTagsHtml(html, contact, extras = {}) {
  if (!html) return html
  const safeContact = {}
  for (const [k, v] of Object.entries(contact || {})) {
    safeContact[k] = typeof v === 'string' ? escapeHtml(v) : v
  }
  const safeExtras = {
    event_name: escapeHtml(extras.event_name || ''),
    team_name: escapeHtml(extras.team_name || ''),
    when: escapeHtml(extras.when || ''),
    location: escapeHtml(extras.location || ''),
  }
  return applyEventMergeTags(html, safeContact, safeExtras)
}

// ============================================================
// BRANDED SHELL
// ============================================================

// The header band. Default = the historic black #000 "UN1T" wordmark. accentHex
// recolours the band; headerImageUrl renders a full-width banner image instead
// (with the accent — or black — as the load/letterbox background).
function headerBlock(accentHex, headerImageUrl) {
  const accent =
    typeof accentHex === 'string' && HEX_RE.test(accentHex.trim()) ? accentHex.trim() : null
  const imageUrl =
    typeof headerImageUrl === 'string' && headerImageUrl.trim() ? headerImageUrl.trim() : null
  const bg = accent || '#000'
  if (imageUrl) {
    return `<div style="background:${bg};text-align:center;padding:0;line-height:0"><img src="${escapeHtml(imageUrl)}" alt="UN1T" width="560" style="display:block;width:100%;max-width:560px;height:auto;border:0;margin:0 auto"/></div>`
  }
  return `<div style="background:${bg};color:#fff;padding:24px;text-align:center;letter-spacing:2px;font-weight:700;font-size:24px">UN1T</div>`
}

// The per-person check-in QR grid. Renders only members that carry a qrSrc.
// `captain` truthy appends the "(captain)" tag (confirmation email); the
// reminder passes plain { name, qrSrc } so no tag renders. Byte-identical to the
// two former inline grids.
function qrBlockHtml(memberQrs) {
  const items = (Array.isArray(memberQrs) ? memberQrs : []).filter((m) => m && m.qrSrc)
  if (!items.length) return ''
  const rows = items
    .map((m) => `<tr>
      <td style="padding:10px 0;font-size:14px;vertical-align:middle">${escapeHtml(m.name)}${m.captain ? ' <em style="color:#666">(captain)</em>' : ''}</td>
      <td style="padding:10px 0;text-align:right"><img src="${escapeHtml(m.qrSrc)}" alt="Check-in code" width="110" height="110" style="border:1px solid #eee;border-radius:8px"/></td>
    </tr>`)
    .join('')
  return `
  <h3 style="font-size:16px;margin:24px 0 8px">Check-in codes</h3>
  <p style="margin:0 0 12px;color:#666;font-size:13px">Show your code to a team member at the door for a quick check-in.</p>
  <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:0 0 24px">
    ${rows}
  </table>`
}

/**
 * The shared branded email skeleton. Composes, top to bottom: header band →
 * heading → intro paragraph → info table → (optional) afterInfoHtml block →
 * (optional) QR grid → the grey "what's next" copy box → the "UN1T · location"
 * signature line.
 *
 * Scalar params (memberQrs[].name, locationName) are escaped here. The raw-HTML
 * slots — heading, introHtml, infoRows, afterInfoHtml, footerHtml — must be
 * pre-escaped by the caller (they legitimately contain markup like <strong> and
 * intentional literal apostrophes such as "You're").
 *
 * @param {object} args
 * @param {string} args.heading         h1 text (raw; caller pre-escaped dynamics)
 * @param {string} args.introHtml       intro <p> inner HTML (raw)
 * @param {?string} args.accentHex      #rrggbb header colour, or null for #000
 * @param {?string} args.headerImageUrl banner image URL, or null for the wordmark
 * @param {string} args.infoRows        the info <table>'s inner rows (raw, indented)
 * @param {Array<{name:string,qrSrc:string,captain?:boolean}>} args.memberQrs
 * @param {string} args.afterInfoHtml   block between the info table and QR grid (raw)
 * @param {string} args.footerHtml      inner HTML of the grey "what's next" box (raw)
 * @param {string} args.locationName    signature-line location (escaped here)
 * @returns {string} HTML body
 */
export function buildEventEmailShell({
  heading = '',
  introHtml = '',
  accentHex = null,
  headerImageUrl = null,
  infoRows = '',
  memberQrs = [],
  afterInfoHtml = '',
  footerHtml = '',
  locationName = '',
} = {}) {
  const header = headerBlock(accentHex, headerImageUrl)
  const qr = qrBlockHtml(memberQrs)
  const loc = escapeHtml(locationName || '')

  return `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;background:#fff;color:#111;max-width:560px;margin:0 auto;padding:24px">
  ${header}
  <h1 style="font-size:24px;margin:24px 0 8px">${heading}</h1>
  <p style="margin:0 0 16px;color:#444;font-size:15px">${introHtml}</p>

  <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:24px 0;font-size:14px">
${infoRows}
  </table>${afterInfoHtml}
${qr}
  <div style="background:#f5f5f5;padding:16px;border-radius:8px;font-size:13px;color:#333;line-height:1.5">
    ${footerHtml}
  </div>

  <p style="color:#999;font-size:12px;margin-top:24px;text-align:center">UN1T · ${loc}</p>
</div>`.trim()
}

// ============================================================
// PER-EVENT RESOLUTION
// ============================================================

// Operator intro copy → the grey "what's next"/"before you arrive" box. Merge
// first (so {{event_name}} etc. resolve), THEN escape the whole result so both
// the operator's literal copy and the merged values are safe, and turn newlines
// into <br> so multi-line copy keeps its breaks.
function renderOperatorIntro(text, contact, extras) {
  const merged = applyEventMergeTags(text, contact, extras)
  return escapeHtml(merged).replaceAll('\n', '<br>')
}

/**
 * Resolve one event email (kind = 'confirmation' | 'reminder') against the
 * per-event configuration on the race row. Returns { subject, htmlBody }.
 *
 * Precedence (see module header):
 *   template_id set → full-HTML email_templates override (merge-tagged).
 *   else            → the shared shell, tinted by accent_hex/hero_image_url,
 *                     with <kind>_email_intro copy in the "what's next" box.
 *
 * `defaults` carries this email's current default subject + the shell slots to
 * render when a field is blank: { subject, heading, introHtml, infoRows,
 * afterInfoHtml, memberQrs, footerHtml, locationName }. With NO per-event config
 * the shell branch reproduces the caller's default builder exactly.
 *
 * A configured-but-missing template row FALLS BACK to the shell rather than
 * throwing — a styling misconfiguration must never drop a live email.
 *
 * @param {object} args
 * @param {import('@supabase/supabase-js').SupabaseClient} [args.db]
 * @param {'confirmation'|'reminder'} args.kind
 * @param {object} args.race     the race_events row (new EVENTS-EMAILCFG columns + accent_hex/hero_image_url)
 * @param {object} args.contact  merge contact ({ first_name, name, email, ... })
 * @param {object} args.extras   { event_name, team_name, when, location }
 * @param {object} args.defaults default subject + shell slots for this email
 * @returns {Promise<{ subject: string, htmlBody: string }>}
 */
export async function resolveEventEmail({ db, kind, race, contact, extras, defaults }) {
  const r = race || {}
  const d = defaults || {}
  const templateId = r[`${kind}_email_template_id`] || null
  const operatorSubject = (r[`${kind}_email_subject`] || '').trim()
  const operatorIntro = (r[`${kind}_email_intro`] || '').trim()

  const subject = operatorSubject
    ? applyEventMergeTags(operatorSubject, contact, extras)
    : (d.subject || '')

  // 1. Advanced: a full email_templates row overrides the shared shell.
  if (templateId && db) {
    try {
      const { data: tpl } = await db
        .from('email_templates')
        .select('subject, html_content')
        .eq('id', templateId)
        .single()
      if (tpl && tpl.html_content) {
        return { subject, htmlBody: applyEventMergeTagsHtml(tpl.html_content, contact, extras) }
      }
      logWarn('event-email', 'template configured but missing/empty; using shell', { kind, templateId })
    } catch (e) {
      logWarn('event-email', 'template load failed; using shell', { kind, templateId, err: e })
    }
  }

  // 2. Shell: branded default, tinted by the event's accent/hero, with the
  //    operator's intro copy in the grey box when set.
  const footerHtml = operatorIntro
    ? renderOperatorIntro(operatorIntro, contact, extras)
    : (d.footerHtml || '')

  const htmlBody = buildEventEmailShell({
    heading: d.heading || '',
    introHtml: d.introHtml || '',
    accentHex: r.accent_hex ?? null,
    headerImageUrl: r.hero_image_url ?? null,
    infoRows: d.infoRows || '',
    memberQrs: d.memberQrs || [],
    afterInfoHtml: d.afterInfoHtml || '',
    footerHtml,
    locationName: d.locationName || '',
  })

  return { subject, htmlBody }
}
