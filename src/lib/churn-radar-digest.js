// RADAR-DIGEST.1 / LEAD-DIGEST.1 — composes the weekly radar digest email.
//
// Pure: (churn summary + history, lead summary + history) -> { subject,
// html }. No I/O — the cron fetches the data and sends; this just
// renders. Kept out of churn-radar.js / lead-radar.js (scoring) so those
// modules stay pure data→data libraries with no presentation concerns.
//
// LEAD-DIGEST.1 folded the Lead Radar funnel into the same Monday email
// so operators see acquisition + retention in one place. The lead block
// is opt-in via opts.lead — when absent the email is churn-only.

// Money-valued metrics format as euros; the rest are plain counts.
const MONEY_METRICS = new Set(['revenueAtRiskCents', 'overdueValueCents'])

// Each churn digest row: [label, summary key (camelCase), snapshot column].
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

// Each lead digest row: [label, getter(summary), snapshot column, delta
// key]. The lead summary nests attending/fresh under .funnel, so a
// getter is cleaner than a flat key path.
const LEAD_DIGEST_ROWS = [
  ['Funnel total',  (s) => s.funnelTotal,       'funnel_total',  'funnelTotal'],
  ['Attending',     (s) => s.funnel?.attending, 'attending',     'attending'],
  ['Fresh leads',   (s) => s.funnel?.fresh,     'fresh',         'fresh'],
  ['Cleanup queue', (s) => s.cleanupTotal,      'cleanup_total', 'cleanupTotal'],
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

// One metric row — shared markup for the churn and lead tables.
function renderRow(label, now, delta, trail) {
  return `<tr>
      <td style="padding:6px 12px;border-bottom:1px solid #eee;">${label}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #eee;font-weight:bold;">${now}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #eee;">${delta} <span style="color:#999;">vs last wk</span></td>
      <td style="padding:6px 12px;border-bottom:1px solid #eee;color:#999;">${trail}</td>
    </tr>`
}

function metricsTable(rowsHtml) {
  return `<table style="border-collapse:collapse;width:100%;font-size:14px;">
    <thead><tr style="text-align:left;color:#888;font-size:12px;">
      <th style="padding:6px 12px;">Metric</th>
      <th style="padding:6px 12px;">Now</th>
      <th style="padding:6px 12px;">Change</th>
      <th style="padding:6px 12px;">Recent weeks</th>
    </tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table>`
}

// Churn section — metrics table + outreach-effectiveness line.
function buildChurnSection(summary, history) {
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
    return renderRow(label, now, delta, trail)
  }).join('')

  const rec = s.recovery || {}
  const recLine = rec.contacted > 0
    ? `<p style="margin:16px 0 0;">Outreach effectiveness: <strong>${rec.recovered} of ${rec.contacted}</strong> members contacted in the last 90 days came back training (${Math.round((rec.recoveryRate || 0) * 100)}%).</p>`
    : ''

  return `<h3 style="margin:24px 0 8px;">Churn radar &mdash; retention</h3>
  ${metricsTable(rowsHtml)}
  ${recLine}`
}

// LEAD-DIGEST.1 — lead section. Returns '' when no lead summary was
// supplied so the email gracefully falls back to churn-only.
function buildLeadSection(summary, history) {
  if (!summary) return ''
  const s = summary
  const deltas = s.trend?.deltas || {}
  const hist = Array.isArray(history) ? history : []

  const rowsHtml = LEAD_DIGEST_ROWS.map(([label, get, col, key]) => {
    const now = String(Number(get(s)) || 0)
    const delta = fmtDelta(key, deltas[key])
    const trail = hist.length
      ? hist.map((h) => String(Number(h[col]) || 0)).join(' → ')
      : '—'
    return renderRow(label, now, delta, trail)
  }).join('')

  const conv = s.conversion || {}
  const convLine = conv.contacted > 0
    ? `<p style="margin:16px 0 0;">Follow-up effectiveness: <strong>${conv.progressed} of ${conv.contacted}</strong> leads contacted in the last 90 days booked or attended afterwards (${Math.round((conv.progressionRate || 0) * 100)}%).</p>`
    : ''

  return `<h3 style="margin:28px 0 8px;">Lead radar &mdash; acquisition</h3>
  ${metricsTable(rowsHtml)}
  ${convLine}`
}

/**
 * Build the weekly radar digest email — churn always, lead when supplied.
 *
 * @param {object}   summary  live churn radarSummary (camelCase; may
 *                            carry a .trend block from computeTrend)
 * @param {object[]} history  recent churn_radar_snapshots rows, OLDEST
 *                            first — rendered as the "recent weeks" trail
 * @param {object}  [opts]    { locationName, radarUrl, leadRadarUrl,
 *                              lead: { summary, history } }
 * @returns {{ subject: string, html: string }}
 */
export function buildDigestEmail(summary, history = [], opts = {}) {
  // CHROME.1 — the studio's name is the OPERATOR's identity and the caller
  // always passes it (`locationName: loc.name`). The fallback only fires on
  // a location with no name, so it must not name one particular tenant's gym.
  const locationName = opts.locationName || 'Your studio'
  const radarUrl = opts.radarUrl || null
  const leadRadarUrl = opts.leadRadarUrl || null

  const churnSection = buildChurnSection(summary, history)
  const leadSection = opts.lead
    ? buildLeadSection(opts.lead.summary, opts.lead.history)
    : ''

  const links = []
  if (radarUrl) {
    links.push(`<a href="${radarUrl}" style="color:#4f46e5;">Open the churn radar &rarr;</a>`)
  }
  if (leadRadarUrl && leadSection) {
    links.push(`<a href="${leadRadarUrl}" style="color:#4f46e5;">Open the lead radar &rarr;</a>`)
  }
  const cta = links.length
    ? `<p style="margin:20px 0 0;">${links.join('&nbsp;&nbsp;&middot;&nbsp;&nbsp;')}</p>`
    : ''

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#222;max-width:640px;">
  <h2 style="margin:0 0 4px;">Weekly radar digest</h2>
  <p style="margin:0 0 4px;color:#888;">${locationName}</p>
  ${churnSection}
  ${leadSection}
  ${cta}
  <p style="margin:24px 0 0;color:#aaa;font-size:12px;">Repset radar &middot; sent every Monday. Manage recipients on the churn radar page.</p>
</div>`

  return {
    subject: `Weekly radar digest — ${locationName}`,
    html,
  }
}
