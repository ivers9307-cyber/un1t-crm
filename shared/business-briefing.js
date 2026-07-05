// shared/business-briefing.js
//
// DASH-REBUILD — deterministic one-line briefing for the Business
// dashboard. Pure template over already-fetched block values: no AI
// call, no randomness, no DB. Shared so mobile can render the same
// sentence later.
//
// buildBusinessBriefing({ revenue, members, attention }) → string
//   revenue:   { totalCents, deltaPct|null }   (MTD, vs same window last month)
//   members:   { count, netChange|null }
//   attention: [{ label }] — pre-ordered; first three are used.

function euro(cents) {
  const n = Math.round((cents || 0) / 100)
  return `€${n.toLocaleString('en-IE')}`
}

function pct(deltaPct) {
  if (deltaPct == null || Number.isNaN(deltaPct)) return null
  const r = Math.round(deltaPct)
  return `${r >= 0 ? '+' : ''}${r}%`
}

export function buildBusinessBriefing({ revenue = {}, members = {}, attention = [] } = {}) {
  const delta = pct(revenue.deltaPct)
  const opener = revenue.deltaPct != null && revenue.deltaPct < 0 ? 'Mixed month so far' : 'Solid month so far'

  const revClause = delta
    ? `${euro(revenue.totalCents)} MTD (${delta})`
    : `${euro(revenue.totalCents)} MTD`

  const net = members.netChange
  const memClause = net != null && net !== 0
    ? `${members.count || 0} members (${net > 0 ? '+' : ''}${net})`
    : `${members.count || 0} members`

  const watch = (attention || []).slice(0, 3).map(a => a.label).filter(Boolean)
  const closer = watch.length ? `Watch: ${watch.join(', ')}.` : 'Nothing urgent.'

  return `${opener}: ${revClause}, ${memClause}. ${closer}`
}
