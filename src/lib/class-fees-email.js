// FEES.5 — the nightly class-fees review email to staff (Richard, 28 Oct
// 2026: "can we design this email?"). Pure: data in, { subject, htmlBody }
// out, so it is testable and previewable without a send.
//
// Email-client safe on purpose: tables for layout, inline styles only, no
// web fonts, no CSS the big clients drop, a light card that reads in a dark
// inbox. Every dynamic value is escaped here.
//
// Layout: studio logo or name, the night and a DRY RUN badge, four stat tiles
// (to charge, forgiven, credits kept, not marked), then one section per list
// (to charge, forgiven with its reason, not marked in un1t.online), then the
// button to the studio's own /class-fees page.

import { escapeHtml } from './html-escape.js'
import { classFeeKindLabel } from './class-fees.js'

const C = Object.freeze({
  page: '#f3f4f6',
  card: '#ffffff',
  ink: '#111827',
  muted: '#6b7280',
  line: '#e5e7eb',
  soft: '#f9fafb',
  accent: '#111827',
  amberBg: '#fef3c7',
  amberInk: '#92400e',
  greenInk: '#065f46',
  greenBg: '#d1fae5',
  blueBg: '#dbeafe',
  blueInk: '#1e40af',
  greyBg: '#f3f4f6',
})
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif"

const euro = (cents) => `€${(Number(cents || 0) / 100).toFixed(2).replace(/\.00$/, '')}`
const e = escapeHtml

function tile(label, value, sub, bg, ink) {
  return `<td width="25%" valign="top" style="padding:6px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${bg};border-radius:10px">
        <tr><td style="padding:14px 12px;font-family:${FONT}">
          <div style="font-size:12px;color:${ink};opacity:.85;text-transform:uppercase;letter-spacing:.04em">${e(label)}</div>
          <div style="font-size:24px;font-weight:700;color:${ink};margin-top:4px">${e(value)}</div>
          ${sub ? `<div style="font-size:12px;color:${ink};opacity:.85;margin-top:2px">${e(sub)}</div>` : ''}
        </td></tr>
      </table>
    </td>`
}

function memberCell(row, contactUrl) {
  const name = e(row.member || 'Member')
  return row.contactId && contactUrl
    ? `<a href="${e(contactUrl(row.contactId))}" style="color:${C.ink};font-weight:600;text-decoration:none">${name}</a>`
    : `<span style="font-weight:600">${name}</span>`
}

function section(title, hint, rowsHtml, emptyText) {
  return `<tr><td style="padding:24px 28px 0;font-family:${FONT}">
      <div style="font-size:16px;font-weight:700;color:${C.ink}">${e(title)}</div>
      ${hint ? `<div style="font-size:13px;color:${C.muted};margin-top:2px">${e(hint)}</div>` : ''}
    </td></tr>
    <tr><td style="padding:10px 28px 0">
      ${rowsHtml
        ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:10px;border-collapse:separate;font-family:${FONT};font-size:14px;color:${C.ink}">${rowsHtml}</table>`
        : `<div style="font-family:${FONT};font-size:14px;color:${C.muted};padding:12px 14px;background:${C.soft};border-radius:10px">${e(emptyText)}</div>`}
    </td></tr>`
}

function rowHtml(cells, last) {
  const border = last ? '' : `border-bottom:1px solid ${C.line};`
  return `<tr>${cells.map((c, i) => `<td style="padding:10px 14px;${border}${i === cells.length - 1 ? 'text-align:right;white-space:nowrap;' : ''}" valign="top">${c}</td>`).join('')}</tr>`
}

const classLine = (r) => `${e(r.classTitle || 'Class')}<div style="font-size:12px;color:${C.muted}">${e(r.classTime || '')}</div>`

/**
 * @param {{ studioName: string, logoUrl?: string|null, dayLabel: string, dryRun: boolean,
 *   chargeLabel: string, due: Array<{ member, contactId, classTitle, classTime, kind, amountCents }>,
 *   forgiven: Array<{ member, contactId, classTitle, classTime, kind, reason }>,
 *   recordedCount: number, undecided: Array<{ member, contactId, classTitle, classTime }>,
 *   outstandingCount: number, noticesSent?: number, reviewUrl: string,
 *   contactUrl?: (id: string) => string }} args
 * @returns {{ subject: string, htmlBody: string }}
 */
export function buildReviewEmail({
  studioName, logoUrl = null, dayLabel, dryRun, chargeLabel,
  due = [], forgiven = [], recordedCount = 0, undecided = [], outstandingCount = 0, noticesSent = 0,
  reviewUrl, contactUrl = null,
}) {
  const total = due.reduce((s, f) => s + (f.amountCents || 0), 0)
  const studio = studioName || 'Studio'
  const subject = dryRun
    ? `${studio} class fees, ${dayLabel} (dry run): ${due.length} would be charged`
    : `${studio} class fees, ${dayLabel}: ${due.length} to charge at ${chargeLabel}`

  const brand = logoUrl
    ? `<img src="${e(logoUrl)}" alt="${e(studio)}" height="36" style="display:block;height:36px;width:auto;border:0">`
    : `<div style="font-size:18px;font-weight:700;color:${C.ink}">${e(studio)}</div>`
  const badge = dryRun
    ? `<span style="display:inline-block;background:${C.amberBg};color:${C.amberInk};font-size:12px;font-weight:700;padding:3px 10px;border-radius:999px;letter-spacing:.04em">DRY RUN</span>`
    : ''
  const lead = dryRun
    ? `Charging is paused, so nothing below is charged and no member is emailed. This is what <b>would</b> be charged at ${e(chargeLabel)}.`
    : `These fees are charged to each member's default card at <b>${e(chargeLabel)}</b> unless you waive them first.`

  const dueRows = due.map((r, i) => rowHtml([
    memberCell(r, contactUrl),
    classLine(r),
    `<span style="font-size:13px;color:${C.muted}">${e(classFeeKindLabel(r.kind))}</span>`,
    `<b>${e(euro(r.amountCents))}</b>`,
  ], i === due.length - 1)).join('')
  const forgivenRows = forgiven.map((r, i) => rowHtml([
    memberCell(r, contactUrl),
    classLine(r),
    `<span style="font-size:13px;color:${C.muted}">${e(classFeeKindLabel(r.kind))}</span>`,
    `<span style="display:inline-block;background:${C.greenBg};color:${C.greenInk};font-size:12px;padding:2px 8px;border-radius:999px">${e(String(r.reason || 'Forgiven').replace(/\s*\(automatic\)$/, ''))}</span>`,
  ], i === forgiven.length - 1)).join('')
  const undecidedRows = undecided.map((r, i) => rowHtml([
    memberCell(r, contactUrl),
    classLine(r),
    `<span style="font-size:13px;color:${C.muted}">Still marked booked</span>`,
  ], i === undecided.length - 1)).join('')

  const extras = [
    outstandingCount ? `${outstandingCount} fee(s) are outstanding after two refused charges.` : null,
    noticesSent ? `${noticesSent} member(s) were emailed about their fee.` : null,
  ].filter(Boolean)

  const htmlBody = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${e(subject)}</title></head>
<body style="margin:0;padding:0;background:${C.page}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.page}">
  <tr><td align="center" style="padding:24px 12px">
    <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="width:100%;max-width:640px;background:${C.card};border-radius:14px;overflow:hidden">
      <tr><td style="padding:24px 28px 0;font-family:${FONT}">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td valign="middle">${brand}</td>
          <td valign="middle" align="right" style="font-size:12px;color:${C.muted};font-family:${FONT}">Class fees · nightly review</td>
        </tr></table>
      </td></tr>
      <tr><td style="padding:20px 28px 0;font-family:${FONT}">
        <div style="font-size:24px;font-weight:700;color:${C.ink}">${e(dayLabel)} ${badge}</div>
        <div style="font-size:14px;color:${C.muted};margin-top:6px;line-height:1.5">${lead}</div>
      </td></tr>
      <tr><td style="padding:16px 22px 0">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          ${tile(dryRun ? 'Would charge' : 'To charge', euro(total), `${due.length} fee(s)`, C.blueBg, C.blueInk)}
          ${tile('Forgiven', String(forgiven.length), 'by your rules', C.greenBg, C.greenInk)}
          ${tile('Credits kept', String(recordedCount), 'pack members', C.greyBg, C.ink)}
          ${tile('Not marked', String(undecided.length), 'in un1t.online', C.amberBg, C.amberInk)}
        </tr></table>
      </td></tr>
      ${section(dryRun ? 'Would be charged' : 'To be charged', null, dueRows, 'No fees tonight.')}
      ${section('Forgiven automatically', 'Waived by the studio\'s rules. Nothing is charged.', forgivenRows, 'Nothing forgiven tonight.')}
      ${undecided.length ? section('Not marked in un1t.online', 'Mark these attended or no-show in un1t.online. A booking still marked booked is never charged.', undecidedRows, '') : ''}
      ${extras.length ? `<tr><td style="padding:16px 28px 0;font-family:${FONT};font-size:13px;color:${C.muted}">${extras.map(e).join('<br>')}</td></tr>` : ''}
      <tr><td align="center" style="padding:28px 28px 8px">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:${C.accent};border-radius:10px">
          <a href="${e(reviewUrl)}" style="display:inline-block;padding:13px 26px;font-family:${FONT};font-size:15px;font-weight:700;color:#ffffff;text-decoration:none">Review ${e(studio)} fees</a>
        </td></tr></table>
      </td></tr>
      <tr><td style="padding:8px 28px 24px;font-family:${FONT};font-size:12px;color:${C.muted};text-align:center;line-height:1.5">
        You get this because you are a review contact for ${e(studio)} class fees. Change who gets it in the class-fees settings.
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`
  return { subject, htmlBody }
}
