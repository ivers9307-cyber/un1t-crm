// BRIEFING.1 — renders the daily morning-briefing email from the
// "Needs attention" feed rows (shared/today-feed.js shapes). Pure:
// (rows, opts) → { subject, html } — no IO, mirroring the
// churn-radar-digest.js convention (the cron fetches + sends).
//
// Recipients see the same triage list the Today page shows, minus the
// approvals row (the approvals registry is per-user scoped; the
// location-level briefing has no viewer to scope by — see
// fetchLocationTodayFeed in today-feed-data.js).

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// '2026-06-01' / ISO timestamp → '1 Jun' (UTC-anchored so the label
// can't drift a day across timezones).
function fmtShortDate(iso) {
  if (!iso) return null
  const d = new Date(String(iso).slice(0, 10) + 'T12:00:00Z')
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString('en-IE', { day: 'numeric', month: 'short', timeZone: 'UTC' })
}

function euro(cents) {
  return `€${Math.round((Number(cents) || 0) / 100).toLocaleString('en-IE')}`
}

/**
 * BRIEFING.2 — shape the "Studio pulse" performance strip. Pure.
 *
 * @param {object} bundle
 *   counts          live computeMembershipCounts() result (membership
 *                   split: recurring / class packs / payg / totals)
 *   radar           live radar summary slice { paused, overdue,
 *                   overdueValueCents } (overdue = Glofox state
 *                   'locked', i.e. payment failed — NOT the stale
 *                   glofox_invoices table)
 *   prevMembership  comparator membership_snapshots row (or null) —
 *                   the cron picks the last snapshot before this
 *                   month, falling back to the oldest available
 *   prevChurn       comparator churn_radar_snapshots row (or null)
 * @returns {Array<{key,label,value,sub?,delta,since}>} [] when live
 *   counts are unavailable (the email just skips the strip).
 */
export function shapePulseMetrics(bundle) {
  const { counts, radar, prevMembership, prevChurn } = bundle || {}
  if (!counts) return []

  const memSince = fmtShortDate(prevMembership?.snapshot_date)
  const churnSince = fmtShortDate(prevChurn?.captured_at)
  const d = (now, prev) => (Number.isFinite(Number(prev)) ? (Number(now) || 0) - Number(prev) : null)

  const metrics = [
    {
      key: 'members',
      label: 'Members (recurring)',
      value: counts.monthly_recurring || 0,
      sub: `${counts.active_recurring || 0} active subscriptions`,
      delta: d(counts.monthly_recurring, prevMembership?.monthly_recurring),
      since: memSince,
    },
    {
      key: 'packs',
      label: 'Class packs',
      value: counts.class_packs || 0,
      sub: `${Math.max(0, (counts.class_packs || 0) - (counts.dead_packs || 0))} with credits left`,
      delta: d(counts.class_packs, prevMembership?.class_packs),
      since: memSince,
    },
    {
      key: 'payg',
      label: 'Pay-as-you-go',
      value: counts.payg || 0,
      delta: d(counts.payg, prevMembership?.payg),
      since: memSince,
    },
    {
      key: 'total',
      label: 'Total members',
      value: counts.total_members || 0,
      delta: d(counts.total_members, prevMembership?.total_members),
      since: memSince,
    },
  ]

  if (radar) {
    metrics.push(
      {
        key: 'paused',
        label: 'Paused',
        value: radar.paused || 0,
        delta: d(radar.paused, prevChurn?.paused),
        since: churnSince,
      },
      {
        key: 'overdue',
        label: 'Overdue payments',
        value: radar.overdue || 0,
        sub: `${euro(radar.overdueValueCents)}/mo at risk`,
        delta: d(radar.overdue, prevChurn?.overdue),
        since: churnSince,
      },
    )
  }

  return metrics
}

// Delta chip for a pulse metric. Green when the count fell ONLY for
// the "bad" metrics (paused/overdue); for the base metrics growth is
// good. Null delta (no comparator yet) renders nothing — the trend
// builds as snapshots accrue.
const SHRINK_IS_GOOD = new Set(['paused', 'overdue'])
function deltaChip(m) {
  if (m.delta === null || m.delta === undefined || !m.since) return ''
  if (m.delta === 0) {
    return `<span style="color:#94a3b8;font-size:12px;">— flat since ${esc(m.since)}</span>`
  }
  const up = m.delta > 0
  const arrow = up ? '▲' : '▼'
  const good = SHRINK_IS_GOOD.has(m.key) ? !up : up
  const color = good ? '#047857' : '#b91c1c'
  return `<span style="color:${color};font-size:12px;font-weight:600;">${arrow} ${Math.abs(m.delta)} since ${esc(m.since)}</span>`
}

/**
 * @param {Array}  rows  assembleTodayFeed() output
 * @param {object} opts  { locationName, dateLabel, appUrl }
 * @returns {{ subject: string, html: string }}
 */
export function buildMorningBriefingEmail(rows, opts = {}) {
  const { locationName = '', dateLabel = '', appUrl = '' } = opts
  const list = Array.isArray(rows) ? rows : []

  // Subject: location + the first two rows as "N label" fragments,
  // lowercased so it reads as a sentence ("2 open issues, 4 high-risk
  // members"). All-clear gets an explicit calm subject.
  const fragments = list.slice(0, 2).map((r) => `${r.count} ${String(r.label).toLowerCase()}`)
  const subject = list.length === 0
    ? `Morning briefing — ${locationName}: all clear`
    : `Morning briefing — ${locationName}: ${fragments.join(', ')}${list.length > 2 ? ', …' : ''}`

  const rowHtml = list.map((r) => {
    const items = (r.items || [])
      .map((it) => esc(it.sublabel ? `${it.label} (${it.sublabel})` : it.label))
      .join(' · ')
    const sub = [r.detail ? esc(r.detail) : null, items || null].filter(Boolean).join(' — ')
    return `
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #e5e7eb;">
          <a href="${appUrl}${r.href}" style="color:#111827;text-decoration:none;font-weight:600;">
            ${esc(r.label)}
            <span style="display:inline-block;min-width:20px;padding:1px 7px;margin-left:6px;border-radius:999px;background:#111827;color:#ffffff;font-size:12px;font-weight:600;">${Number(r.count) || 0}</span>
          </a>
          ${sub ? `<div style="margin-top:3px;color:#64748b;font-size:13px;">${sub}</div>` : ''}
          <div style="margin-top:3px;"><a href="${appUrl}${r.href}" style="color:#4f46e5;font-size:13px;">Open &rarr;</a></div>
        </td>
      </tr>`
  }).join('')

  const body = list.length === 0
    ? `<p style="color:#64748b;font-size:14px;">Nothing needs attention this morning — all clear. Enjoy the quiet.</p>`
    : `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rowHtml}</table>`

  // BRIEFING.2 — the "Studio pulse" performance strip: membership
  // split + paused + overdue, each with a since-last-snapshot delta.
  // Renders above the triage list; absent entirely when the cron
  // couldn't assemble it (fail-soft).
  const pulse = Array.isArray(opts.pulse) ? opts.pulse : []
  const pulseHtml = pulse.length === 0 ? '' : `
    <h3 style="margin:0 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:0.05em;color:#64748b;">Studio pulse</h3>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
      ${pulse.map((m) => `
      <tr>
        <td style="padding:7px 0;border-bottom:1px solid #f1f5f9;color:#334155;font-size:13px;">
          ${esc(m.label)}
          ${m.sub ? `<div style="color:#94a3b8;font-size:11px;">${esc(m.sub)}</div>` : ''}
        </td>
        <td style="padding:7px 8px;border-bottom:1px solid #f1f5f9;text-align:right;white-space:nowrap;">
          <span style="color:#111827;font-size:15px;font-weight:700;">${Number(m.value) || 0}</span>
        </td>
        <td style="padding:7px 0;border-bottom:1px solid #f1f5f9;text-align:right;white-space:nowrap;">
          ${deltaChip(m)}
        </td>
      </tr>`).join('')}
    </table>`

  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;">
    <h2 style="margin:0 0 2px;font-size:18px;color:#111827;">Morning briefing — ${esc(locationName)}</h2>
    <p style="margin:0 0 16px;color:#64748b;font-size:13px;">${esc(dateLabel)}</p>
    ${pulseHtml}
    ${body}
    <p style="margin:18px 0 0;color:#94a3b8;font-size:12px;">
      The live view is always on <a href="${appUrl}/dashboard/today" style="color:#4f46e5;">your Today dashboard</a>.
      This briefing goes to the same recipients as the Monday radar digest.
    </p>
  </div>`

  return { subject, html }
}
