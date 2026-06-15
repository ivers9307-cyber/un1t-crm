import { describe, it, expect } from 'vitest'
import { aggregatePerson } from './person-aggregate'

// ---------------------------------------------------------------------------
// Chainable Supabase mock — same pattern as person-links.test.js.
// Extended with .range() for pagination compatibility.
// ---------------------------------------------------------------------------
function makeDb(tables = {}) {
  const store = {}
  for (const [k, v] of Object.entries(tables)) {
    store[k] = typeof v === 'function' ? v : [...v]
  }

  function builder(table) {
    const state = {
      table,
      op: 'select',
      filters: [],
      payload: null,
      single: false,
      maybeSingle: false,
      selectCols: '*',
      limitN: null,
      rangeFrom: null,
      rangeTo: null,
    }

    function resolve() {
      let src = store[state.table]
      if (!src) src = []
      const rows = typeof src === 'function' ? src(state) : src

      if (state.op === 'select') {
        let result = rows.filter(row =>
          state.filters.every(f => {
            if (f.type === 'in') return f.vals.includes(row[f.col])
            if (f.type === 'eq') return row[f.col] === f.val
            return true
          }),
        )

        // Apply range if set (simulate pagination)
        if (state.rangeFrom !== null && state.rangeTo !== null) {
          result = result.slice(state.rangeFrom, state.rangeTo + 1)
        } else if (state.limitN !== null) {
          result = result.slice(0, state.limitN)
        }

        if (state.single) return { data: result[0] || null, error: null }
        if (state.maybeSingle) return { data: result[0] || null, error: null }
        return { data: result, error: null }
      }

      return { data: null, error: null }
    }

    const b = {
      select(cols) { state.selectCols = cols || '*'; return b },
      eq(col, val) { state.filters.push({ col, val, type: 'eq' }); return b },
      in(col, vals) { state.filters.push({ col, vals, type: 'in' }); return b },
      order() { return b },
      limit(n) { state.limitN = n; return b },
      range(from, to) { state.rangeFrom = from; state.rangeTo = to; return b },
      single() { state.single = true; return b },
      maybeSingle() { state.maybeSingle = true; return b },
      then(resolve_fn, reject_fn) {
        let value
        try { value = resolve() } catch (e) {
          return Promise.resolve().then(() => reject_fn ? reject_fn(e) : Promise.reject(e))
        }
        return Promise.resolve(value).then(resolve_fn, reject_fn)
      },
    }
    return b
  }

  const db = { from: (table) => builder(table), _store: store }
  return db
}

// ---------------------------------------------------------------------------
// Seed data for the "3 member group" scenario.
//
// Members:
//   c-primary  — real active member, primary
//   c-shadow   — ClassPass shadow sharing the placeholder phone
//   c-dormant  — dormant (inactive) real contact
//
// Phone dedup: c-primary and c-shadow share +35311111111 (placeholder)
//   → normalises to '111111111' → should collapse to one phone entry
//
// Email dedup: c-primary and c-dormant have the same email lowercased
//   → should collapse to one email entry (contactable = true/false based on
//     whichever has the best status)
//
// Arrears:
//   pd-survive — PAST_DUE €25.00 (2500 cents) for c-primary; no matching PAID → survives
//   pd-netted  — PAST_DUE €30.00 (3000 cents) for c-dormant; matching PAID same amount
//                within 1 day → netted out by nettedOutByRetry
// ---------------------------------------------------------------------------

const GROUP_ID = 'g-test-1'
const PRIMARY_ID = 'c-primary'
const SHADOW_ID = 'c-shadow'
const DORMANT_ID = 'c-dormant'

const personGroups = [
  { id: GROUP_ID, primary_contact_id: PRIMARY_ID, location_id: 'loc-1', note: null },
]

const personGroupMembers = [
  { id: 'm1', group_id: GROUP_ID, contact_id: PRIMARY_ID },
  { id: 'm2', group_id: GROUP_ID, contact_id: SHADOW_ID },
  { id: 'm3', group_id: GROUP_ID, contact_id: DORMANT_ID },
]

const contacts = [
  {
    id: PRIMARY_ID,
    name: 'Alice Real',
    first_name: 'Alice',
    last_name: 'Real',
    email: 'alice@example.com',
    email_status: 'active',          // contactable = true
    phone: '+353 87 111 1111',
    wa_phone: null,
    glofox_member_id: 'gfx-alice',
    glofox_membership_status: 'member',
    glofox_membership_state: 'active',
    glofox_account_active: true,
    pipeline_stage_slug: 'active_member',
    last_attended_at: '2026-06-10T10:00:00Z',
    total_attended_30d: 5,
  },
  {
    id: SHADOW_ID,
    name: 'Alice Classpass',
    first_name: 'Alice',
    last_name: 'Classpass',
    email: 'alice.cp@example.com',  // different email
    email_status: 'active',
    phone: '+353 87 111 1111',       // SAME placeholder phone as primary
    wa_phone: null,
    glofox_member_id: null,
    glofox_membership_status: 'classpass_payg',
    glofox_membership_state: null,
    glofox_account_active: false,
    pipeline_stage_slug: 'classpass_active',
    last_attended_at: null,
    total_attended_30d: 2,
  },
  {
    id: DORMANT_ID,
    name: 'Alice Old',
    first_name: 'Alice',
    last_name: 'Old',
    email: 'ALICE@EXAMPLE.COM',     // same email as primary, different case → dedup
    email_status: 'bounced',         // contactable = false
    phone: '+353 87 222 2222',       // different phone
    wa_phone: null,
    glofox_member_id: 'gfx-old',
    glofox_membership_status: 'member',
    glofox_membership_state: null,
    glofox_account_active: false,
    pipeline_stage_slug: 'dormant',
    last_attended_at: '2025-01-01T10:00:00Z',
    total_attended_30d: 0,
  },
]

// Invoices for arrears:
//   pd-survive: PAST_DUE for PRIMARY (glofox_user_id='gfx-alice'), €25 (2500 cents)
//              no matching PAID → should survive
//   pd-netted:  PAST_DUE for DORMANT (glofox_user_id='gfx-old'), €30 (3000 cents)
//              matched by paid-netted (same user, same amount, within 1 day) → netted
const glofoxInvoices = [
  {
    id: 'pd-survive',
    contact_id: PRIMARY_ID,
    glofox_user_id: 'gfx-alice',
    amount_cents: 2500,
    invoice_date: '2026-06-01T10:00:00Z',
    status: 'PAST_DUE',
    location_id: 'loc-1',
  },
  {
    id: 'pd-netted',
    contact_id: DORMANT_ID,
    glofox_user_id: 'gfx-old',
    amount_cents: 3000,
    invoice_date: '2026-05-15T09:00:00Z',
    status: 'PAST_DUE',
    location_id: 'loc-1',
  },
  {
    // The matching PAID that nets out pd-netted
    id: 'paid-netted',
    contact_id: DORMANT_ID,
    glofox_user_id: 'gfx-old',
    amount_cents: 3000,
    invoice_date: '2026-05-15T11:30:00Z',   // ~2.5 hours later, same day → within 1-day window
    status: 'PAID',
    location_id: 'loc-1',
  },
]

// Deals across members
const deals = [
  { id: 'd1', contact_id: PRIMARY_ID, status: 'open', title: 'Primary deal' },
  { id: 'd2', contact_id: DORMANT_ID, status: 'closed', title: 'Dormant old deal' },
]

// Activities for timeline — 55 rows to test the 50 cap
function mkActivities() {
  const rows = []
  for (let i = 0; i < 55; i++) {
    const contactId = i % 3 === 0 ? PRIMARY_ID : i % 3 === 1 ? SHADOW_ID : DORMANT_ID
    rows.push({
      id: `act-${i}`,
      contact_id: contactId,
      type: 'note',
      title: `Activity ${i}`,
      created_at: new Date(2026, 5, 15 - i).toISOString(), // newest first when sorted desc
    })
  }
  return rows
}
const activities = mkActivities()

function makeSeededDb() {
  return makeDb({
    person_groups: personGroups,
    person_group_members: personGroupMembers,
    contacts,
    glofox_invoices: glofoxInvoices,
    deals,
    activities,
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('aggregatePerson', () => {
  it('returns null for an unknown groupId', async () => {
    const db = makeDb({
      person_groups: [],
      person_group_members: [],
    })
    const result = await aggregatePerson(db, 'non-existent-group')
    expect(result).toBeNull()
  })

  it('returns null when the group exists but has no members', async () => {
    const db = makeDb({
      person_groups: [{ id: 'g-empty', primary_contact_id: 'c1' }],
      person_group_members: [],
    })
    const result = await aggregatePerson(db, 'g-empty')
    expect(result).toBeNull()
  })

  it('returns the groupId and primaryContactId', async () => {
    const db = makeSeededDb()
    const result = await aggregatePerson(db, GROUP_ID)
    expect(result).not.toBeNull()
    expect(result.groupId).toBe(GROUP_ID)
    expect(result.primaryContactId).toBe(PRIMARY_ID)
  })

  it('builds accounts with 3 entries, primary first and isPrimary correct', async () => {
    const db = makeSeededDb()
    const result = await aggregatePerson(db, GROUP_ID)
    expect(result.accounts).toHaveLength(3)
    expect(result.accounts[0].contactId).toBe(PRIMARY_ID)
    expect(result.accounts[0].isPrimary).toBe(true)
    // Other accounts must have isPrimary=false
    expect(result.accounts.slice(1).every(a => a.isPrimary === false)).toBe(true)
  })

  it('deduplicates emails by lowercased value, tags each with the right sourceContactId, marks contactable based on email_status', async () => {
    const db = makeSeededDb()
    const result = await aggregatePerson(db, GROUP_ID)

    // alice@example.com appears for PRIMARY (active) and DORMANT (bounced, different case)
    // → should deduplicate to one entry; first-seen wins for the entry
    const aliceEmails = result.emails.filter(e => e.value === 'alice@example.com')
    expect(aliceEmails).toHaveLength(1)

    // alice.cp@example.com from SHADOW — separate, contactable
    const cpEmails = result.emails.filter(e => e.value === 'alice.cp@example.com')
    expect(cpEmails).toHaveLength(1)
    expect(cpEmails[0].contactable).toBe(true)
    expect(cpEmails[0].sourceContactId).toBe(SHADOW_ID)

    // The deduped alice@example.com entry is contactable (primary has active status)
    expect(aliceEmails[0].contactable).toBe(true)
    expect(aliceEmails[0].sourceContactId).toBe(PRIMARY_ID)
  })

  it('deduplicates phones by normalised last-9-digits, collapsing the shared ClassPass placeholder', async () => {
    const db = makeSeededDb()
    const result = await aggregatePerson(db, GROUP_ID)

    // +353 87 111 1111 normalises to '871111111' — shared by PRIMARY and SHADOW
    // → should collapse to one phone entry
    const shared = result.phones.filter(p => p.value.replace(/\D/g, '').slice(-9) === '871111111')
    expect(shared).toHaveLength(1)

    // +353 87 222 2222 from DORMANT — distinct
    const dormantPhone = result.phones.filter(p => p.value.replace(/\D/g, '').slice(-9) === '872222222')
    expect(dormantPhone).toHaveLength(1)

    // Total: 2 distinct normalised phones
    expect(result.phones).toHaveLength(2)
  })

  it('calculates arrearsCents as only the surviving PAST_DUE (the netted one excluded)', async () => {
    const db = makeSeededDb()
    const result = await aggregatePerson(db, GROUP_ID)

    // pd-survive: 2500 cents PAST_DUE, no matching PAID → survives
    // pd-netted: 3000 cents PAST_DUE, matched by paid-netted (same user, same amount, same day) → excluded
    expect(result.arrearsCents).toBe(2500)
  })

  it('counts attendedBookingsCount from attended bookings across all member contacts', async () => {
    // primary=5, shadow=2, dormant=0 → sum=7
    const db = makeSeededDb()
    const result = await aggregatePerson(db, GROUP_ID)
    expect(result.attended).toBe(7)
  })

  it('counts dealsCount as total deals across all member contacts', async () => {
    const db = makeSeededDb()
    const result = await aggregatePerson(db, GROUP_ID)
    // 2 deals seeded (d1 for PRIMARY, d2 for DORMANT)
    expect(result.dealsCount).toBe(2)
  })

  it('returns timeline newest-first, each entry carries sourceContactId', async () => {
    const db = makeSeededDb()
    const result = await aggregatePerson(db, GROUP_ID)

    // Every timeline entry must have sourceContactId
    expect(result.timeline.every(e => e.sourceContactId != null)).toBe(true)

    // Timeline should be newest-first (created_at descending)
    for (let i = 0; i < result.timeline.length - 1; i++) {
      expect(result.timeline[i].createdAt >= result.timeline[i + 1].createdAt).toBe(true)
    }
  })

  it('caps timeline at 50 entries even when more exist', async () => {
    // We seeded 55 activities; the function should only return 50
    const db = makeSeededDb()
    const result = await aggregatePerson(db, GROUP_ID)
    expect(result.timeline.length).toBeLessThanOrEqual(50)
    // Specifically, we request limit(50) so we get exactly 50 (we seeded 55)
    expect(result.timeline.length).toBe(50)
  })

  it('returns the correct shape with all required fields', async () => {
    const db = makeSeededDb()
    const result = await aggregatePerson(db, GROUP_ID)
    expect(result).toMatchObject({
      groupId: expect.any(String),
      primaryContactId: expect.any(String),
      accounts: expect.any(Array),
      emails: expect.any(Array),
      phones: expect.any(Array),
      arrearsCents: expect.any(Number),
      attended: expect.any(Number),
      dealsCount: expect.any(Number),
      timeline: expect.any(Array),
    })
  })
})
