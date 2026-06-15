import { describe, it, expect } from 'vitest'
import { loadOverdue, loadRadar } from './churn-radar-data'

// ARREARS-NETTING.1 (Fix B) — the live Overdue feature must net cross-
// invoice-id payment retries out of the chase-list + total, the same way the
// arrears tool does. A PAST_DUE `glofox_invoices` row whose member
// (glofox_user_id) has a same-`amount_cents` PAID row within ±7 days is a
// settled retry and must NOT appear in Overdue.
//
// These exercise the full data path (fetchPastDue → netting → buildOverdue →
// splitArrears) through a small chainable Supabase mock. The pure netting
// itself is covered exhaustively in arrears-retry-netting.test.js.

// A thenable query builder that records .from(table) + the .eq('status', …)
// filter and resolves to a per-(table, status) row set. Every chain method
// returns `this`; awaiting resolves { data, error }.
function makeDb(tables) {
  function builder(table) {
    const state = { table, status: undefined, single: false }
    const b = {
      select() { return b },
      eq(col, val) { if (col === 'status') state.status = val; return b },
      not() { return b },
      in() { return b },
      gte() { return b },
      order() { return b },
      range() { return b },
      limit() { return b },
      maybeSingle() { state.single = true; return b },
      then(resolve, reject) {
        let rows
        try {
          const src = tables[state.table]
          rows = typeof src === 'function' ? src(state) : (src || [])
        } catch (e) { return Promise.resolve().then(() => reject(e)) }
        const value = state.single ? { data: rows[0] || null, error: null } : { data: rows, error: null }
        return Promise.resolve(value).then(resolve, reject)
      },
    }
    return b
  }
  return { from: (table) => builder(table) }
}

const LOC = 'loc-1'
// Use a fixed "now" so daysOverdue etc. are deterministic.
const NOW = Date.parse('2026-06-01T00:00:00Z')

function gInvoice({ id, glofox_user_id, contact_id, amount_cents, status, invoice_date }) {
  return { id, glofox_user_id, contact_id, amount_cents, status, invoice_date, location_id: LOC }
}
function contact({ id, name = 'Member' }) {
  return {
    id, name,
    glofox_membership_status: 'member',
    glofox_membership_type: 'time',
    glofox_membership_plan: 'Monthly Membership',
    last_attended_at: null,
    last_payment_at: null,
  }
}

describe('loadOverdue — retry netting (Fix B)', () => {
  it('excludes a PAST_DUE invoice settled by a same-member same-amount PAID within ±7 days', async () => {
    const db = makeDb({
      glofox_invoices: (state) => {
        if (state.status === 'PAST_DUE') {
          return [gInvoice({ id: 'pd1', glofox_user_id: 'fran', contact_id: 'c-fran', amount_cents: 9900, status: 'PAST_DUE', invoice_date: '2026-05-27T10:36:00Z' })]
        }
        if (state.status === 'PAID') {
          return [gInvoice({ id: 'p1', glofox_user_id: 'fran', contact_id: 'c-fran', amount_cents: 9900, status: 'PAID', invoice_date: '2026-05-27T10:40:00Z' })]
        }
        return []
      },
      churn_radar_actions: [],
      contacts: [contact({ id: 'c-fran', name: 'Fran' })],
    })
    const { overdue, summary } = await loadOverdue(db, LOC, NOW)
    expect(overdue).toHaveLength(0)
    expect(summary.total).toBe(0)
    expect(summary.totalValueCents).toBe(0)
  })

  it('keeps a PAST_DUE invoice whose only same-amount PAID is 10 days away', async () => {
    const db = makeDb({
      glofox_invoices: (state) => {
        if (state.status === 'PAST_DUE') {
          return [gInvoice({ id: 'pd1', glofox_user_id: 'gus', contact_id: 'c-gus', amount_cents: 9900, status: 'PAST_DUE', invoice_date: '2026-05-01T10:00:00Z' })]
        }
        if (state.status === 'PAID') {
          return [gInvoice({ id: 'p1', glofox_user_id: 'gus', contact_id: 'c-gus', amount_cents: 9900, status: 'PAID', invoice_date: '2026-05-11T10:00:00Z' })]
        }
        return []
      },
      churn_radar_actions: [],
      contacts: [contact({ id: 'c-gus', name: 'Gus' })],
    })
    const { overdue, summary } = await loadOverdue(db, LOC, NOW)
    expect(overdue).toHaveLength(1)
    expect(overdue[0].contactId).toBe('c-gus')
    expect(summary.totalValueCents).toBe(9900)
  })

  it('keeps a PAST_DUE invoice when the in-window PAID is a different amount', async () => {
    const db = makeDb({
      glofox_invoices: (state) => {
        if (state.status === 'PAST_DUE') {
          return [gInvoice({ id: 'pd1', glofox_user_id: 'hana', contact_id: 'c-hana', amount_cents: 9900, status: 'PAST_DUE', invoice_date: '2026-05-27T10:36:00Z' })]
        }
        if (state.status === 'PAID') {
          return [gInvoice({ id: 'p1', glofox_user_id: 'hana', contact_id: 'c-hana', amount_cents: 4000, status: 'PAID', invoice_date: '2026-05-27T10:40:00Z' })]
        }
        return []
      },
      churn_radar_actions: [],
      contacts: [contact({ id: 'c-hana', name: 'Hana' })],
    })
    const { overdue } = await loadOverdue(db, LOC, NOW)
    expect(overdue).toHaveLength(1)
    expect(overdue[0].contactId).toBe('c-hana')
  })

  it('nets only one of two identical PAST_DUE invoices against a single PAID retry', async () => {
    // Same member, two distinct €99 PAST_DUE rows in-window, one PAID retry.
    // One nets out; the other remains — its €99 still owed, so it shows in Overdue.
    const db = makeDb({
      glofox_invoices: (state) => {
        if (state.status === 'PAST_DUE') {
          return [
            gInvoice({ id: 'pd1', glofox_user_id: 'iris', contact_id: 'c-iris', amount_cents: 9900, status: 'PAST_DUE', invoice_date: '2026-05-27T10:36:00Z' }),
            gInvoice({ id: 'pd2', glofox_user_id: 'iris', contact_id: 'c-iris', amount_cents: 9900, status: 'PAST_DUE', invoice_date: '2026-05-27T11:00:00Z' }),
          ]
        }
        if (state.status === 'PAID') {
          return [gInvoice({ id: 'p1', glofox_user_id: 'iris', contact_id: 'c-iris', amount_cents: 9900, status: 'PAID', invoice_date: '2026-05-27T10:40:00Z' })]
        }
        return []
      },
      churn_radar_actions: [],
      contacts: [contact({ id: 'c-iris', name: 'Iris' })],
    })
    const { overdue, summary } = await loadOverdue(db, LOC, NOW)
    expect(overdue).toHaveLength(1)
    expect(overdue[0].contactId).toBe('c-iris')
    // Only the un-netted invoice's amount remains.
    expect(summary.totalValueCents).toBe(9900)
    expect(overdue[0].invoiceCount).toBe(1)
  })
})

// ── CHURN-RADAR-PERSON-AWARE: loadRadar person-group integration ──────────────
//
// Tests that `applyPersonRollup` is wired correctly into the three loaders.
// We extend the mock builder so it tracks both .eq() filters and .not() calls,
// allowing dispatch to differentiate between:
//   - contacts loaded via .eq('location_id') for member sweep (key: 'contacts')
//   - contacts loaded via .eq('location_id') + .not('person_group_id', 'is', null)
//     for the cross-status activity path (key: 'contacts:grouped')
//   - person_groups loaded via .eq('location_id') (key: 'person_groups:location')
//   - contacts loaded via .in('id', ...) for the overdue path (key: 'contacts:id')

function makeDbPersonAware(tables) {
  function builder(table) {
    const state = { table, inCol: null, notCol: null, eqFilters: {}, single: false }
    const b = {
      select() { return b },
      eq(col, val) { state.eqFilters[col] = val; return b },
      not(col) { state.notCol = col; return b },
      in(col) { state.inCol = col; return b },
      gte() { return b },
      order() { return b },
      range() { return b },
      limit() { return b },
      maybeSingle() { state.single = true; return b },
      then(resolve, reject) {
        let rows
        try {
          // Determine dispatch key based on which filters were set.
          // Priority: explicit in() col > not(col) > table default.
          let key
          if (state.inCol) {
            key = `${table}:${state.inCol}`
          } else if (state.notCol) {
            // .not('person_group_id', ...) on contacts = cross-status grouped load
            key = `${table}:grouped`
          } else {
            // person_groups with .eq('location_id') goes to 'person_groups:location'
            // for disambiguation from any other person_groups query
            if (table === 'person_groups' && state.eqFilters.location_id) {
              key = 'person_groups:location'
            } else {
              key = table
            }
          }
          const src = tables[key] !== undefined ? tables[key] : tables[table]
          rows = typeof src === 'function' ? src(state) : (src || [])
        } catch (e) { return Promise.resolve().then(() => reject(e)) }
        const value = state.single ? { data: rows[0] || null, error: null } : { data: rows, error: null }
        return Promise.resolve(value).then(resolve, reject)
      },
    }
    return b
  }
  return { from: (table) => builder(table) }
}

// A dormant-member contact shape — last_attended ~600 days ago, zero 30d
// attendance, has a live time-based membership. Should be flagged at-risk
// normally (gone-quiet > 45d → actually 'out' in buildRadar because
// QUIET_MAX_DAYS=45; so it won't appear in radar rows — perfect for the Mark
// case: without rollup he never appears in radar but still counts in summary;
// with rollup the combined activity moves him to active+attended, so scorer
// picks him up as low-risk but the rollup also replaces last_attended so
// classifyContact sees footprint → 'active', then gone-quiet window checks
// days since last attended → 3 days < 14 = no signals → NOT at-risk).
//
// Actually the simpler read: with recent activity (3 days), classifyContact
// sees footprint → 'active'. scoreMember checks each detector — gone_quiet
// needs ≥14 days since last attended (3d < 14 → no signal), disengaging
// needs total_attended_30d ≥ 4 (6 > 4) AND total_attended_7d === 0 (we leave
// 7d at 0 — so disengaging WOULD fire. Let's give total_attended_7d = 1 to
// prevent it). So with combined: 6 attended/30d, 1/7d, last_attended 3d ago
// → zero signals → scoreMember returns null → NOT in radar list.
// Without rollup the dormant member has last_attended 600d ago → classifyContact
// → 'active' (has footprint), scoreMember → gone_quiet fires (600d > 45d →
// QUIET_MAX_DAYS=45 → actually 45d is the MAX; > MAX means they're off the
// radar too). Let's use 30 days for dormant — in window (14–45d) → scored.
// That way without rollup they appear at-risk, with rollup they don't.

function dormantMember({ id, name = 'Mark', person_group_id = null } = {}) {
  return {
    id, name,
    location_id: LOC,
    glofox_membership_status: 'member',
    glofox_membership_type: 'time',
    glofox_membership_plan: 'Monthly Membership',
    glofox_membership_state: 'active',
    glofox_membership_expiry: null,
    glofox_membership_price_cents: 9900,
    glofox_billing_interval: '1 month',
    trial_credits_remaining: null,
    // 30 days ago — inside the gone-quiet window (14–45d) → at-risk without rollup
    last_attended_at: new Date(NOW - 30 * 86_400_000).toISOString(),
    last_booked_at: null,
    last_payment_at: new Date(NOW - 5 * 86_400_000).toISOString(),
    total_attended_30d: 0,
    total_attended_7d: 0,
    total_noshow_30d: 0,
    total_bookings_30d: 0,
    joined_at: new Date(NOW - 365 * 86_400_000).toISOString(),
    lifetime_value_cents: 50000,
    person_group_id,
  }
}

function activeClasspassContact({ id, person_group_id }) {
  // A classpass_payg contact (NOT in MEMBER_STATUSES) sharing the same group.
  // Attended 3 days ago with 6/30d sessions.
  return {
    id, person_group_id,
    last_attended_at: new Date(NOW - 3 * 86_400_000).toISOString(),
    last_booked_at: new Date(NOW - 3 * 86_400_000).toISOString(),
    total_attended_30d: 6,
    total_attended_7d: 1,
    total_noshow_30d: 0,
  }
}

const GROUP_ID = 'group-mark'

describe('loadRadar — person-group-aware (CHURN-RADAR-PERSON-AWARE)', () => {
  // ── Mark case ────────────────────────────────────────────────────────────
  // The key test: a dormant member contact (in the at-risk window) whose
  // person group has an active classpass_payg account. After rollup, the
  // combined activity shows recent attendance → NOT at-risk.
  it('Mark case — dormant member with active ClassPass sibling is NOT in radar', async () => {
    const markMember = dormantMember({ id: 'c-mark-member', person_group_id: GROUP_ID })
    const markClasspass = activeClasspassContact({ id: 'c-mark-cp', person_group_id: GROUP_ID })

    const db = makeDbPersonAware({
      // fetchMembers returns the dormant member (only member-status contacts)
      contacts: [markMember],
      // applyPersonRollup — person_groups location-scoped load
      'person_groups:location': [{ id: GROUP_ID, primary_contact_id: 'c-mark-member', location_id: LOC }],
      // applyPersonRollup — cross-status grouped contacts (location-scoped, not null person_group_id)
      'contacts:grouped': [markMember, markClasspass],
      // Other tables used by loadRadar
      churn_radar_actions: [],
      glofox_invoices: [],
      churn_radar_snapshots: [],
    })

    const { radar, summary } = await loadRadar(db, LOC, NOW)

    // With combined activity (3d recent, 6/30d), gone-quiet doesn't fire
    // (3d < 14d threshold) and disengaging doesn't fire (total_attended_30d ≥ 4).
    // scoreMember returns null → Mark is NOT in the at-risk list.
    const markRow = radar.find((r) => r.contactId === 'c-mark-member')
    expect(markRow).toBeUndefined()

    // But Mark IS in the active base (classifyContact sees footprint → 'active')
    expect(summary.activeBase).toBeGreaterThanOrEqual(1)
  })

  // ── Dedup: two member accounts in the same group ─────────────────────────
  it('dedup — two member contacts in the same group count as ONE person in radar', async () => {
    const memberA = dormantMember({ id: 'c-dedup-a', name: 'Twin A', person_group_id: GROUP_ID })
    const memberB = dormantMember({ id: 'c-dedup-b', name: 'Twin B', person_group_id: GROUP_ID })

    const db = makeDbPersonAware({
      contacts: [memberA, memberB],
      'person_groups:location': [{ id: GROUP_ID, primary_contact_id: 'c-dedup-a', location_id: LOC }],
      // Both members in the cross-status fetch; combined = 0+0 = 0 attended 30d,
      // last_attended stays 30 days ago → at-risk as one person, not two.
      'contacts:grouped': [memberA, memberB],
      churn_radar_actions: [],
      glofox_invoices: [],
      churn_radar_snapshots: [],
    })

    const { radar, summary } = await loadRadar(db, LOC, NOW)

    // Active base should count them as ONE person (deduplicated to primary c-dedup-a)
    expect(summary.activeBase).toBe(1)

    // The radar list should show at most 1 row for this group (the primary)
    const dedupRows = radar.filter((r) => r.contactId === 'c-dedup-a' || r.contactId === 'c-dedup-b')
    expect(dedupRows.length).toBeLessThanOrEqual(1)
    // The non-primary 'c-dedup-b' should never appear
    expect(radar.find((r) => r.contactId === 'c-dedup-b')).toBeUndefined()
  })

  // ── Ungrouped unaffected ─────────────────────────────────────────────────
  it('ungrouped — a dormant member with no person_group_id still appears at-risk', async () => {
    // No person_group_id — goes through unchanged via the fast path
    const ungroupedMember = dormantMember({ id: 'c-ungrouped', person_group_id: null })

    const db = makeDbPersonAware({
      contacts: [ungroupedMember],
      // person_groups + cross-status contacts should not be called (fast path: no grouped rows)
      // but we leave them empty just in case to avoid false errors
      'person_groups:location': [],
      'contacts:grouped': [],
      churn_radar_actions: [],
      glofox_invoices: [],
      churn_radar_snapshots: [],
    })

    const { radar } = await loadRadar(db, LOC, NOW)

    // Dormant member (30d no attendance) is in gone-quiet window → at-risk
    const row = radar.find((r) => r.contactId === 'c-ungrouped')
    expect(row).toBeDefined()
    expect(row.signals.some((s) => s.key === 'gone_quiet')).toBe(true)
  })

  // ── Degrade-safe ─────────────────────────────────────────────────────────
  it('degrade-safe — person_groups query error → loadRadar still returns a result', async () => {
    const markMember = dormantMember({ id: 'c-mark-err', person_group_id: GROUP_ID })

    const db = makeDbPersonAware({
      contacts: [markMember],
      // Simulate person_groups throwing an error
      'person_groups:location': () => { throw new Error('DB exploded') },
      'contacts:grouped': [],
      churn_radar_actions: [],
      glofox_invoices: [],
      churn_radar_snapshots: [],
    })

    // Should not throw — degrades gracefully using raw members
    const { summary } = await loadRadar(db, LOC, NOW)

    // The result uses raw rows (no dedup) — Mark appears at-risk as before
    expect(summary.activeBase).toBeGreaterThanOrEqual(1)
    expect(typeof summary.atRisk).toBe('number')
    // No exception should be thrown
  })
})
