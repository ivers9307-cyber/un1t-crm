// UN1TRADAR.1 — a fixed Glofox-shaped studio for the "Stillorgan unchanged"
// tests: a small in-memory supabase fake answering the contacts,
// glofox_invoices, action and snapshot reads the radar data layers make.
// Rows are filtered by eq / in / gte / not-null so each reader gets what its
// query asks for. Fixtures use example.com addresses only.

export const LOC = 'loc-glofox'
export const NOW = Date.parse('2026-10-18T12:00:00Z')
const DAY = 86_400_000
const iso = (ms) => new Date(ms).toISOString()

const member = (over) => ({
  location_id: LOC, glofox_membership_status: 'member', glofox_membership_type: 'time',
  glofox_membership_plan: 'Monthly Membership', glofox_membership_state: 'active',
  glofox_membership_expiry: null, glofox_membership_price_cents: 12000, glofox_billing_interval: '1 month',
  trial_credits_remaining: null, last_attended_at: null, last_booked_at: null, last_payment_at: null,
  total_attended_30d: 0, total_attended_7d: 0, total_noshow_30d: 0, total_bookings_30d: 0,
  joined_at: '2025-01-01T00:00:00Z', lifetime_value_cents: 50000, person_group_id: null,
  email: null, phone: null, lead_source: null, ...over,
})

export function glofoxContacts() {
  return [
    member({ id: 'c01', name: 'Quiet', last_attended_at: iso(NOW - 20 * DAY), total_attended_30d: 1 }),
    member({ id: 'c02', name: 'Regular', last_attended_at: iso(NOW - 8 * DAY), total_attended_30d: 6, total_attended_7d: 0 }),
    member({ id: 'c03', name: 'Renewing', last_attended_at: iso(NOW - 2 * DAY), total_attended_30d: 2, glofox_membership_expiry: iso(NOW + 10 * DAY) }),
    member({ id: 'c04', name: 'Pack', glofox_membership_status: 'credit_member', glofox_membership_type: 'num_classes', glofox_membership_plan: '10 Class Pack', trial_credits_remaining: 1, last_attended_at: iso(NOW - 3 * DAY) }),
    member({ id: 'c05', name: 'Ghost' }),
    member({ id: 'c06', name: 'Owes', last_attended_at: iso(NOW - 4 * DAY) }),
    member({ id: 'c07', name: 'Paused', glofox_membership_state: 'paused', last_attended_at: iso(NOW - 30 * DAY) }),
    member({ id: 'c08', name: 'Lapsed', glofox_membership_status: 'ex_member', last_attended_at: iso(NOW - 70 * DAY) }),
    member({ id: 'c09', name: 'Noshow', last_attended_at: iso(NOW - 5 * DAY), total_noshow_30d: 3, total_attended_30d: 1 }),
    member({ id: 'c10', name: 'Snoozed', last_attended_at: iso(NOW - 20 * DAY) }),
    member({ id: 'c11', name: 'Dismissed', last_attended_at: iso(NOW - 20 * DAY) }),
    member({ id: 'l01', name: 'Trialist', glofox_membership_status: 'trial', last_attended_at: iso(NOW - 6 * DAY), joined_at: iso(NOW - 10 * DAY), email: 'l01@example.com' }),
    member({ id: 'l02', name: 'Fresh lead', glofox_membership_status: 'lead', joined_at: iso(NOW - 20 * DAY), email: 'l02@example.com' }),
    member({ id: 'l03', name: 'Old lead', glofox_membership_status: 'lead', joined_at: iso(NOW - 500 * DAY) }),
    member({ id: 'l04', name: 'Drop in', glofox_membership_status: 'classpass_payg', last_attended_at: iso(NOW - 9 * DAY) }),
  ]
}

const invoices = () => [
  { id: 'i1', location_id: LOC, contact_id: 'c06', glofox_user_id: 'g6', amount_cents: 12000, invoice_date: iso(NOW - 12 * DAY), status: 'PAST_DUE', line_item_subtypes: 'SUBSCRIPTION_RENEWAL', glofox_event: null },
  { id: 'i2', location_id: LOC, contact_id: 'c09', glofox_user_id: 'g9', amount_cents: 1500, invoice_date: iso(NOW - 3 * DAY), status: 'PAST_DUE', line_item_subtypes: 'CUSTOM_CHARGE', glofox_event: null },
  { id: 'i3', location_id: LOC, contact_id: 'c02', glofox_user_id: 'g2', amount_cents: 1000, invoice_date: iso(NOW - 1 * DAY), status: 'PENDING', line_item_subtypes: 'CUSTOM_CHARGE', glofox_event: null },
]

const actions = () => [
  { location_id: LOC, contact_id: 'c10', action: 'snoozed', snooze_until: iso(NOW + 5 * DAY), created_at: iso(NOW - DAY) },
  { location_id: LOC, contact_id: 'c11', action: 'dismissed', snooze_until: null, created_at: iso(NOW - 2 * DAY) },
  { location_id: LOC, contact_id: 'c01', action: 'contacted', snooze_until: null, created_at: iso(NOW - 3 * DAY) },
]

export function glofoxFixtureDb() {
  const tables = {
    contacts: glofoxContacts(),
    glofox_invoices: invoices(),
    churn_radar_actions: actions(),
    lead_radar_actions: [{ location_id: LOC, contact_id: 'l02', action: 'contacted', snooze_until: null, created_at: iso(NOW - DAY) }],
    churn_radar_snapshots: [{ location_id: LOC, captured_at: iso(NOW - 7 * DAY), active_base: 7, at_risk: 2, high_risk: 1, overdue: 1, paused: 1, quarantine: 1, revenue_at_risk_cents: 24000, overdue_value_cents: 12000 }],
    lead_radar_snapshots: [{ location_id: LOC, captured_at: iso(NOW - 7 * DAY), funnel_total: 1, attending: 1, fresh: 0, cleanup_total: 1 }],
    member_friendships: [],
    person_groups: [],
  }
  function builder(table) {
    const s = { filters: [], range: null, single: false, limit: null }
    const run = () => {
      let rows = (tables[table] || []).filter((r) => s.filters.every(([k, c, v]) => {
        if (k === 'eq') return r[c] === v
        if (k === 'in') return v.includes(r[c])
        if (k === 'gte') return r[c] != null && String(r[c]) >= String(v)
        if (k === 'notnull') return r[c] != null
        return true
      }))
      if (table === 'churn_radar_snapshots' || table === 'lead_radar_snapshots') rows = [...rows].sort((a, b) => b.captured_at.localeCompare(a.captured_at))
      if (s.range) rows = rows.slice(s.range[0], s.range[1] + 1)
      if (s.limit != null) rows = rows.slice(0, s.limit)
      if (s.single) return { data: rows[0] ?? null, error: null }
      return { data: rows.map((r) => ({ ...r })), error: null }
    }
    const api = {
      select() { return api },
      eq(c, v) { s.filters.push(['eq', c, v]); return api },
      in(c, v) { s.filters.push(['in', c, v]); return api },
      gte(c, v) { s.filters.push(['gte', c, v]); return api },
      not(c) { s.filters.push(['notnull', c]); return api },
      order() { return api },
      range(a, b) { s.range = [a, b]; return api },
      limit(n) { s.limit = n; return api },
      maybeSingle() { s.single = true; return api },
      then(res, rej) { return Promise.resolve().then(run).then(res, rej) },
    }
    return api
  }
  return { from: (t) => builder(t) }
}
