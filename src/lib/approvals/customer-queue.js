// The merged customer list for the approvals page (APPROVALSQ.1). Pure: no
// imports, no DB, never mutates the providers it is given.

export const CUSTOMER_PROVIDER_KEYS = ['agent_requests', 'trial_purchases', 'corp_promo_claims', 'offer_purchases']

export const CUSTOMER_FILTER_LABELS = {
  agent_requests: 'Mia requests',
  trial_purchases: 'Paid trials',
  corp_promo_claims: 'Corporate promos',
  offer_purchases: 'Offer sales',
}

function ms(value) {
  if (!value) return null
  const t = Date.parse(value)
  return Number.isFinite(t) ? t : null
}

// Class start soonest first, then the rest oldest-submitted first, a missing
// submittedAt last. Array.prototype.sort is stable, so ties keep input order.
function compareItems(a, b) {
  const sa = ms(a?.details?.starts_at)
  const sb = ms(b?.details?.starts_at)
  if (sa !== null && sb !== null) return sa - sb
  if (sa !== null) return -1
  if (sb !== null) return 1
  const ta = ms(a?.submittedAt)
  const tb = ms(b?.submittedAt)
  if (ta !== null && tb !== null) return ta - tb
  if (ta !== null) return -1
  if (tb !== null) return 1
  return 0
}

const tag = (key) => (item) => ({ ...item, providerKey: key })

// `_nowMs` is accepted for the page's call shape; ordering is by absolute
// time, so it is not needed here.
export function buildCustomerQueue(providers, _nowMs = Date.now()) {
  const list = Array.isArray(providers) ? providers : []
  const present = CUSTOMER_PROVIDER_KEYS
    .map((key) => list.find((p) => p?.key === key))
    .filter(Boolean)

  const needsFixing = []
  const waiting = []
  for (const p of present) {
    if (p.key === 'agent_requests' && Array.isArray(p.failedItems)) {
      needsFixing.push(...p.failedItems.map(tag(p.key)))
    }
    if (Array.isArray(p.items)) waiting.push(...p.items.map(tag(p.key)))
  }
  needsFixing.sort(compareItems)
  waiting.sort(compareItems)

  const chips = present.map((p) => ({
    key: p.key,
    label: CUSTOMER_FILTER_LABELS[p.key],
    count: Number(p.count) || 0,
  }))
  const total = chips.reduce((sum, c) => sum + c.count, 0)
  return { needsFixing, waiting, chips, total }
}

export function teamProviders(providers) {
  return (Array.isArray(providers) ? providers : []).filter((p) => !CUSTOMER_PROVIDER_KEYS.includes(p?.key))
}

export function filterQueue(queue, key) {
  const needsFixing = queue?.needsFixing || []
  const waiting = queue?.waiting || []
  if (!key || key === 'all') return { needsFixing, waiting }
  return {
    needsFixing: needsFixing.filter((i) => i.providerKey === key),
    waiting: waiting.filter((i) => i.providerKey === key),
  }
}
