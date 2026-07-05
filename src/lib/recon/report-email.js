// src/lib/recon/report-email.js
//
// RCOV.P0 — weekly coverage report. Pure renderer (unit-tested) +
// thin send wrapper over the Postmark helper. Recipients come from
// RECEIPT_COVERAGE_REPORT_TO (comma-separated) — REQUIRED, no silent
// fallback per repo convention (the cron checks it up-front and fails
// loudly).
import { sendEmail } from '@/lib/postmark'

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const eur = (n) => {
  const v = Number(n) || 0
  const abs = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(Math.abs(v))
  return v < 0 ? `-${abs}` : abs
}

// Dublin-hour gate for the Friday cron: vercel.json fires at both
// 07:00 and 08:00 UTC on Fridays (see the two crons entries) because
// a single UTC cron can't track Dublin's GMT/IST straddle — this gate
// picks whichever firing lands in the 08:xx Dublin wall-clock hour,
// and alreadyRanToday absorbs the other firing plus any retry/manual
// re-fire from landing a second run the same day.
export function shouldRunFridayCron({ dublinMinutes, alreadyRanToday }) {
  const hour = Math.floor(dublinMinutes / 60)
  return hour === 8 && !alreadyRanToday
}

function foundSectionHtml(found) {
  if (found.length === 0) return ''
  return `
    <h4 style="margin:16px 0 4px;color:#2e7d32">Found &amp; submitted this week</h4>
    <table cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:13px;width:100%">
      <tr style="text-align:left;border-bottom:1px solid #ddd">
        <th>Date</th><th>Description</th><th>Supplier</th><th style="text-align:right">Amount</th>
      </tr>
      ${found.map((l) => `
      <tr style="border-bottom:1px solid #eee">
        <td>${esc(l.line_date)}</td>
        <td>${esc(l.description)}</td>
        <td>${esc(l.supplier_name)}${l.deduped ? ' (already in queue)' : ''}</td>
        <td style="text-align:right;white-space:nowrap">${eur(l.amount)}</td>
      </tr>`).join('')}
    </table>`
}

function inReviewSectionHtml(inReview) {
  if (inReview.length === 0) return ''
  return `
    <h4 style="margin:16px 0 4px">In review — working through the invoice queue</h4>
    <table cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:13px;width:100%">
      <tr style="text-align:left;border-bottom:1px solid #ddd">
        <th>Date</th><th>Description</th><th style="text-align:right">Amount</th><th>Stage</th>
      </tr>
      ${inReview.map((l) => `
      <tr style="border-bottom:1px solid #eee">
        <td>${esc(l.line_date)}</td>
        <td>${esc(l.description)}</td>
        <td style="text-align:right;white-space:nowrap">${eur(l.amount)}</td>
        <td>${esc(l.queue_status)}</td>
      </tr>`).join('')}
    </table>`
}

function needsAttentionSectionHtml(needsAttention) {
  if (needsAttention.length === 0) return ''
  return `
    <h4 style="margin:16px 0 4px;color:#c62828">Needs your attention — submitted document was rejected</h4>
    <table cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:13px;width:100%">
      <tr style="text-align:left;border-bottom:1px solid #ddd">
        <th>Date</th><th>Description</th><th style="text-align:right">Amount</th><th>Reason</th>
      </tr>
      ${needsAttention.map((l) => `
      <tr style="border-bottom:1px solid #eee">
        <td>${esc(l.line_date)}</td>
        <td>${esc(l.description)}</td>
        <td style="text-align:right;white-space:nowrap">${eur(l.amount)}</td>
        <td>${esc(l.reject_reason)}</td>
      </tr>`).join('')}
    </table>`
}

export function renderCoverageReportHtml({ appUrl, dateStr, sections, errors }) {
  const sectionHtml = sections.map((s) => {
    const found = s.found || []
    const inReview = s.inReview || []
    const needsAttention = s.needsAttention || []
    return `
    <h3 style="margin:24px 0 4px">${esc(s.locationName)}</h3>
    <p style="margin:0 0 8px;color:#555;font-size:13px">
      ${s.stats.pulled} unreconciled line${s.stats.pulled === 1 ? '' : 's'} ·
      ${s.stats.new} new this week · ${s.stats.covered} covered since last pull
    </p>
    ${(s.anomalies || []).length === 0 ? '' : `
      <p style="font-size:13px;color:#c62828;margin:0 0 8px">
        ⚠ Anomaly: sync skipped for ${s.anomalies.map((a) => esc(a.bankAccountName || a.bankAccountId)).join(', ')} —
        report parsed to zero rows (possible report-shape drift). Coverage for ${s.anomalies.length === 1 ? 'this account' : 'these accounts'} was NOT updated.
      </p>`}
    ${foundSectionHtml(found)}
    ${inReviewSectionHtml(inReview)}
    ${needsAttentionSectionHtml(needsAttention)}
    ${s.uncovered.length === 0
      ? '<p style="font-size:13px;color:#2e7d32">Every tracked transaction is covered or in review. 🎉</p>'
      : `<h4 style="margin:16px 0 4px">Still no invoice found — chase list</h4>
        <table cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:13px;width:100%">
          <tr style="text-align:left;border-bottom:1px solid #ddd">
            <th>Date</th><th>Description</th><th>Ref</th><th style="text-align:right">Amount</th>
          </tr>
          ${s.uncovered.map((l) => `
          <tr style="border-bottom:1px solid #eee">
            <td>${esc(l.line_date)}</td>
            <td>${esc(l.description)}</td>
            <td>${esc(l.reference)}</td>
            <td style="text-align:right;white-space:nowrap">${eur(l.amount)}</td>
          </tr>`).join('')}
        </table>`}
  `
  }).join('')

  const errorHtml = errors.length === 0 ? '' : `
    <h3 style="margin:24px 0 4px;color:#c62828">Problems this run</h3>
    ${errors.map((e) => `<p style="font-size:13px;margin:2px 0">${esc(e.locationName)}: ${esc(e.error)}</p>`).join('')}
  `

  return `
  <div style="font-family:system-ui,sans-serif;max-width:640px">
    <h2 style="margin:0 0 4px">Receipt coverage — week of ${esc(dateStr)}</h2>
    <p style="margin:0 0 16px;font-size:13px;color:#555">
      Transactions below have no receipt collected yet.
      <a href="${esc(appUrl)}/accounting">Open the coverage board</a> to action them.
    </p>
    ${sectionHtml}
    ${errorHtml}
  </div>`
}

export function reportRecipients() {
  const raw = process.env.RECEIPT_COVERAGE_REPORT_TO
  if (!raw) throw new Error('RECEIPT_COVERAGE_REPORT_TO is not set (comma-separated recipient list)')
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
}

export async function sendCoverageReport({ html, dateStr }) {
  const to = reportRecipients().join(',')
  return sendEmail({
    to,
    subject: `Receipt coverage — ${dateStr}`,
    htmlBody: html,
    stream: 'outbound',
    tag: 'receipt-coverage',
  })
}
