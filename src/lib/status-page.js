// STATUS-PAGE.1 — pure mapping from internal integration-health rows to the
// PUBLIC, member-facing status view. This is the trust boundary: it collapses
// internal detail (cron names, counts, error strings) into four plain-language
// member services + one overall verdict, reading ONLY each row's status —
// never its `detail`/`remedy` — so nothing internal can leak to a customer.
//
// Copy is override-able per location via locations.settings.status_page, with
// these defaults as the fallback (operator-editable-copy invariant).

// internal ok/warn/down/unknown → member operational/degraded/down.
// 'unknown' (an integration simply not configured for this location) must NOT
// alarm a customer — it is treated as operational.
export function toMemberStatus(internal) {
  if (internal === 'down') return 'down'
  if (internal === 'warn') return 'degraded'
  return 'operational' // ok + unknown
}

// Each member-facing service rolls up one or more internal row-key prefixes.
export const MEMBER_SERVICES = [
  { key: 'booking', from: ['crons', 'webhooks', 'glofox'] },
  { key: 'messaging', from: ['wa'] },
  { key: 'payments', from: ['payments'] },
  { key: 'email', from: ['email'] },
]

const RANK = { operational: 0, degraded: 1, down: 2 }
function worseMember(a, b) { return RANK[b] > RANK[a] ? b : a }

// Default, operator-override-able copy. `ok` vs `bad` line per service.
export const DEFAULT_COPY = {
  brand: 'UN1T',
  services: {
    booking: {
      label: 'Class booking & app',
      ok: 'Booking, schedules and your member app are working normally.',
      bad: 'Booking or the app may be slow right now.',
    },
    messaging: {
      label: 'Messaging & reminders',
      ok: 'WhatsApp replies and class reminders are sending on time.',
      bad: 'Replies and reminders may be slower than usual.',
    },
    payments: {
      label: 'Payments',
      ok: 'Card payments and membership billing are processing.',
      bad: 'Some payments may not be going through.',
    },
    email: {
      label: 'Email updates',
      ok: 'Confirmations, receipts and updates are being delivered.',
      bad: 'Some emails may be delayed.',
    },
  },
  verdict: {
    operational: {
      tag: 'All operational',
      headline: 'Everything’s running.',
      subline: 'All services are working normally. Book your classes and train — we’ll flag anything here the moment it changes.',
    },
    degraded: {
      tag: 'Partial disruption',
      headline: 'We’re on it.',
      subline: 'Most things are working. Some services may be slower than usual right now — the team has been alerted and is looking into it.',
    },
    down: {
      tag: 'Service disruption',
      headline: 'We’re on it.',
      subline: 'One or more services are down. The team has been alerted and is working on it — thanks for your patience.',
    },
  },
}

// Shallow-merge per section so a partial override (e.g. just one service line)
// keeps every other default. overrides = locations.settings.status_page.
function mergeCopy(overrides) {
  const o = overrides && typeof overrides === 'object' ? overrides : {}
  const services = {}
  for (const key of Object.keys(DEFAULT_COPY.services)) {
    services[key] = { ...DEFAULT_COPY.services[key], ...(o.services?.[key] || {}) }
  }
  const verdict = {}
  for (const key of Object.keys(DEFAULT_COPY.verdict)) {
    verdict[key] = { ...DEFAULT_COPY.verdict[key], ...(o.verdict?.[key] || {}) }
  }
  return { brand: o.brand || DEFAULT_COPY.brand, services, verdict }
}

/**
 * Build the public status view from internal integration-health rows.
 * @param {Array<{key:string,status:string}>} rows  getIntegrationHealth output
 * @param {object} [overrides]  locations.settings.status_page copy overrides
 * @returns {{ overall, services:[{key,label,status,desc}], verdict, brand }}
 */
export function buildStatusView(rows, overrides = {}) {
  const copy = mergeCopy(overrides)
  const list = Array.isArray(rows) ? rows : []
  const byPrefix = (prefix) => list.filter((r) => String(r?.key || '').split(':')[0] === prefix)

  const services = MEMBER_SERVICES.map(({ key, from }) => {
    const internal = from.flatMap(byPrefix)
    // No internal rows for this service → operational (nothing says it's broken).
    const status = internal.length
      ? internal.map((r) => toMemberStatus(r.status)).reduce(worseMember, 'operational')
      : 'operational'
    const c = copy.services[key]
    return { key, label: c.label, status, desc: status === 'operational' ? c.ok : c.bad }
  })

  const overall = services.map((s) => s.status).reduce(worseMember, 'operational')
  return { overall, services, verdict: copy.verdict[overall], brand: copy.brand }
}
