// The merged team-and-money list for the approvals page (APPROVALSQ.4). Pure:
// never mutates the providers it is given.
import { teamProviders } from './customer-queue'

function ms(value) {
  if (!value) return null
  const t = Date.parse(value)
  return Number.isFinite(t) ? t : null
}

// Oldest submitted first, a missing or unreadable submittedAt last. Array
// sort is stable, so ties keep provider order.
function compare(a, b) {
  const ta = ms(a?.submittedAt)
  const tb = ms(b?.submittedAt)
  if (ta !== null && tb !== null) return ta - tb
  if (ta !== null) return -1
  if (tb !== null) return 1
  return 0
}

export function buildTeamQueue(providers) {
  const team = teamProviders(providers)
  const items = []
  for (const p of team) {
    if (!Array.isArray(p.items)) continue
    items.push(...p.items.map((item) => ({ ...item, providerKey: p.key, providerLabel: p.label })))
  }
  items.sort(compare)
  const chips = team.map((p) => ({ key: p.key, label: p.label, count: Number(p.count) || 0 }))
  const total = chips.reduce((sum, c) => sum + c.count, 0)
  return { items, chips, total }
}

export function filterTeamQueue(queue, key) {
  const items = queue?.items || []
  if (!key || key === 'all') return items
  return items.filter((i) => i.providerKey === key)
}
