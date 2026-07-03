// src/lib/ads/report.js
// Daily ads performance email (per-location). Pure builders — no I/O.
// Mirrors morning-briefing.js markup conventions (inline styles, esc()).

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
const eur = (n) => `€${Math.round(Number(n || 0) * 100) / 100}`
const cpaStr = (c) => (c == null ? '—' : `€${Math.round(Number(c) * 100) / 100}`)

/** One-line plain-English callout: cheapest booking + biggest waste.
 *  Handles the all-zero and no-bookings-anywhere cases. */
export function buildCallout(perAd) {
  const rows = Array.isArray(perAd) ? perAd : []
  const withBookings = rows.filter((r) => Number(r.bookings) > 0 && r.cpa != null)
  const noBookings = rows.filter((r) => Number(r.bookings) === 0 && Number(r.spend) > 0)
  if (!withBookings.length && !noBookings.length) return 'No ad activity to report yet.'
  const parts = []
  if (withBookings.length) {
    const best = withBookings.reduce((a, b) => (b.cpa < a.cpa ? b : a))
    parts.push(`${best.name} is your cheapest booking at ${cpaStr(best.cpa)}`)
  }
  if (noBookings.length) {
    const worst = noBookings.reduce((a, b) => (Number(b.spend) > Number(a.spend) ? b : a))
    parts.push(`${worst.name} spent ${eur(worst.spend)} with no bookings`)
  }
  return parts.join('; ') + '.'
}

/** Build the daily per-location report email. Returns { subject, html }. */
export function buildAdReportEmail({ locationName, date, kpis = {}, perAd = [], deltas = {}, appUrl = '' }) {
  const spend = eur(kpis.spend)
  const bookings = Number(kpis.bookings || 0)
  const cpa = cpaStr(kpis.cpa)
  const subject = `${locationName} ads — ${date}: ${spend} → ${bookings} booked, ${cpa}/booking`
  const callout = buildCallout(perAd)
  const rowsHtml = (perAd || []).map((r) => `
      <tr>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;">${esc(r.name)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;">${eur(r.spend)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;">${Number(r.ctr || 0)}%</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;">${Number(r.bookings || 0)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;font-weight:600;">${cpaStr(r.cpa)}</td>
      </tr>`).join('')
  const link = appUrl
    ? `<p style="margin:16px 0 0;"><a href="${esc(appUrl)}/dashboard/ads" style="color:#2563eb;">View the ads dashboard →</a></p>`
    : ''
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;color:#111;">
      <h2 style="margin:0 0 4px;">${esc(locationName)} — Ads</h2>
      <p style="margin:0 0 16px;color:#666;">${esc(date)}</p>
      <p style="font-size:16px;margin:0 0 16px;"><strong>${spend}</strong> spent → <strong>${bookings}</strong> booked class${bookings === 1 ? '' : 'es'} · <strong>${cpa}</strong> per booking</p>
      <p style="margin:0 0 16px;padding:10px 12px;background:#f4f6f8;border-radius:6px;">${esc(callout)}</p>
      <table style="border-collapse:collapse;width:100%;font-size:14px;">
        <thead><tr>
          <th style="padding:6px 10px;text-align:left;border-bottom:2px solid #ddd;">Ad</th>
          <th style="padding:6px 10px;text-align:right;border-bottom:2px solid #ddd;">Spend</th>
          <th style="padding:6px 10px;text-align:right;border-bottom:2px solid #ddd;">CTR</th>
          <th style="padding:6px 10px;text-align:right;border-bottom:2px solid #ddd;">Booked</th>
          <th style="padding:6px 10px;text-align:right;border-bottom:2px solid #ddd;">Cost/booking</th>
        </tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>${link}
    </div>`
  return { subject, html }
}
