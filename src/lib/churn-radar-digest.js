// RADAR-DIGEST.1 — composes the weekly churn-radar digest email.
//
// Pure: (live summary, recent snapshot history) -> { subject, html }.
// No I/O — the cron fetches the data and sends; this just renders.
// Kept out of churn-radar.js (scoring) so that module stays a pure
// data→data library with no presentation concerns.

// Money-valued metrics format as euros; the rest are plain counts.
const MONEY_METRICS = new Set(['revenueAtRiskCents', 'overdueValueCents'])

// Each digest row: [label, summary key (camelCase), snapshot column].
const DIGEST_ROWS = [
  ['Active base',     'activeBase',         'active_base'],
  ['At risk',         'atRisk',             'at_risk'],
  ['High risk',       'highRisk',           'high_risk'],
  ['Overdue',         'overdue',            'overdue'],
  ['Paused',          'paused',             'paused'],
  ['Quarantine',      'quarantine',         'quarantine'],
  ['Revenue at risk', 'revenueAtRiskCents', 'revenue_at_risk_cents'],
  ['Overdue value',   'overdueValueCents',  'overdue_value_cents'],
]

function fmtMoney(cents) {
  return `€${Math.round((Number(cents) || 0) / 100).toLocaleString('en-IE')}`
}

function fmtValue(key, n) {
  return MONEY_METRICS.has(key) ? fmtMoney(n) : String(Number(n) || 0)
}

function fmtDelta(key, d) {
  if (!Number.isFinite(d) || d === 0) return '—'
  const arrow = d > 0 ? '▲' : '▼'
  const mag = MONEY_METRICS.has(key) ? fmtMoney(Math.abs(d)) : Math.abs(d)
  return `${arrow} ${mag}`
}

/**
 * Build the weekly churn-radar digest email.
 *
 * @param {object} summary   live radarSummary output (camelCase; may
 *                           carry a .trend block from computeTrend)
 * @param {object[]} history recent churn_radar_snapshots rows, OLDEST
 *                           first — rendered as the "recent weeks" trail
 * @param {object} [opts]    { locationName, radarUrl }
 * @returns {{ subject: string, html: string }}
 */
export function buildDigestEmail(summary, history = [], opts = {}) {
  const locationName = opts.locationName || 'UN1T'
  const radarUrl = opts.radarUrl || null
  const s = summary || {}
  const deltas = s.trend?.deltas || {}
  const hist = Array.isArray(history) ? history : []

  const rowsHtml = DIGEST_ROWS.map(([label, key, col]) => {
    const now = fmtValue(key, s[key])
    const delta = fmtDelta(key, deltas[key])
    // The trail is the snapshot history; "Now" (live) is the column
    // after it — the operator reads left-to-right ending at today.
    const trail = hist.length
      ? hist.map((h) => fmtValue(key, h[col])).join(' → ')
      : '—'
    return `<tr>
      <td style="padding:6px 12px;border-bottom:1px solid #eee;">${label}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #eee;font-weight:bold;">${now}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #eee;">${delta} <span style="color:#999;">vs last wk</span></td>
      <td style="padding:6px 12px;border-bottom:1px solid #eee;color:#999;">${trail}</td>
    </tr>`
  }).join('')

  const rec = s.recovery || {}
  const recLine = rec.contacted > 0
    ? `<p style="margin:16px 0 0;">Outreach effectiveness: <strong>${rec.recovered} of ${rec.contacted}</strong> members contacted in the last 90 days came back training (${Math.round((rec.recoveryRate || 0) * 100)}%).</p>`
    : ''

  const cta = radarUrl
    ? `<p style="margin:20px 0 0;"><a href="${radarUrl}" style="color:#4f46e5;">Open the churn radar &rarr;</a></p>`
    : ''

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#222;max-width:640px;">
  <h2 style="margin:0 0 4px;">Churn radar &mdash; weekly digest</h2>
  <p style="margin:0 0 16px;color:#888;">${locationName}</p>
  <table style="border-collapse:collapse;width:100%;font-size:14px;">
    <thead><tr style="text-align:left;color:#888;font-size:12px;">
      <th style="padding:6px 12px;">Metric</th>
      <th style="padding:6px 12px;">Now</th>
      <th style="padding:6px 12px;">Change</th>
      <th style="padding:6px 12px;">Recent weeks</th>
    </tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table>
  ${recLine}
  ${cta}
  <p style="margin:24px 0 0;color:#aaa;font-size:12px;">UN1T churn radar &middot; sent every Monday. Manage recipients on the churn radar page.</p>
</div>`

  return {
    subject: `Churn radar weekly digest — ${locationName}`,
    html,
  }
}
