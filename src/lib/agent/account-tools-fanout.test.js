// PERSON-ACCT.3 — one person often has 2-3 `contacts` rows, each carrying
// different Glofox-synced membership/attendance fields (person_groups).
// Before this task get_my_membership/get_my_next_class/get_my_recent_attendance
// read ONLY the verified contact's own row, so a member whose live membership,
// next class or recent attendance lived on a sibling contact row got wrong
// answers ("no membership" / "no upcoming class" / "0 attended").
//
// The two invariants these tests exist to hold:
//   1. all three reads fan out across every linked contact in the person
//      group, and
//   2. an UNREADABLE group (linkedAccountsForContact reports readFailed)
//      never becomes a wrong/empty answer — it falls back to today's
//      single-contact behaviour, unchanged.
import { describe, it, expect, vi } from 'vitest'
import { executeAccountTool } from './account-tools'

// Mirrors booking-tools-fanout.test.js's chainable double: a `contacts`
// table keyed by id/ids, a `person_group_members` table answering both the
// membership lookup (cols include 'group_id') and the group-members list,
// and a no-op `glofox_memberships` catalog (tests never set a
// glofox_membership_plan on the chosen row, so the catalog branch never
// fires and never needs real rows).
function stubDb(trace, { contacts = [], groupId = 'g-1', groupReadError = null } = {}) {
  return {
    from(table) {
      const st = { table, cols: '', filters: {}, op: null }
      const settle = (single) => {
        if (table === 'person_group_members') {
          if (groupReadError) return { data: null, error: groupReadError }
          if (st.cols.includes('group_id')) return { data: { group_id: groupId }, error: null }
          return { data: contacts.map((c) => ({ contact_id: c.id })), error: null }
        }
        if (table === 'contacts') {
          const want = st.filters.id
          const list = Array.isArray(want)
            ? contacts.filter((c) => want.includes(c.id))
            : contacts.filter((c) => c.id === want)
          if (Array.isArray(want)) trace.push({ step: 'in', cols: st.cols, ids: [...want] })
          return single ? { data: list[0] || null, error: null } : { data: list, error: null }
        }
        if (table === 'glofox_memberships') {
          return { data: [], error: null }
        }
        return { data: single ? null : [], error: null }
      }
      const b = {
        // Every select is traced (not just the .in() ones below) so a test
        // can pin an exact column list — a double that ignores its select
        // argument entirely is how a column can be silently dropped from a
        // production query without any test noticing (a real quality gap
        // found in this task: the widened selects were unpinned).
        select(cols) { st.cols = cols || ''; trace.push({ step: 'select', table, cols: st.cols }); return b },
        eq(col, val) { st.filters[col] = val; return b },
        in(col, vals) { st.filters[col] = vals; return b },
        limit: () => b,
        order: () => b,
        async maybeSingle() { return settle(true) },
        async single() { return settle(true) },
        then(resolve, reject) { return Promise.resolve(settle(false)).then(resolve, reject) },
      }
      return b
    },
  }
}

const ctx = (db) => ({
  db,
  conversationId: 'conv-1',
  conversationsTable: 'whatsapp_conversations',
  contactId: 'c-1',
  verifiedContactId: 'c-1',
  locationId: 'loc-1',
  channel: 'whatsapp',
  nameHint: 'Vanessa',
})

// PERSON-ACCT.3 — glofox_membership_status is NEVER the string 'active' in
// prod (real values: member, credit_member, trial, classpass_payg, lead,
// ...). A row is genuinely "bookable" via hasBookableMembership: status ∈
// {member, credit_member} AND state is 'active' or null/never-set. These
// fixtures use realistic status values throughout — a literal
// glofox_membership_status: 'active' can never occur and would be testing
// dead code.
describe('get_my_membership fans out across the person group', () => {
  it('a row with a bookable membership (member + active state) wins over a trial-with-credits row and a more recently updated row', async () => {
    const group = [
      { id: 'c-1', glofox_membership_status: 'trial', trial_credits_remaining: 0, updated_at: '2026-01-01T00:00:00Z', glofox_membership_state: 'inactive', glofox_account_active: false },
      { id: 'c-2', glofox_membership_status: 'trial', trial_credits_remaining: 3, updated_at: '2026-06-01T00:00:00Z', glofox_membership_state: 'future', glofox_account_active: false },
      { id: 'c-3', glofox_membership_status: 'member', trial_credits_remaining: 0, updated_at: '2025-01-01T00:00:00Z', glofox_membership_state: 'active', glofox_account_active: true },
    ]
    const res = await executeAccountTool('get_my_membership', {}, ctx(stubDb([], { contacts: group })))
    expect(res).toEqual({ found: true, status: 'active', raw_state: 'active', account_active: true })
  })

  it('a trial-with-credits row wins over a more recently updated row that is neither bookable nor a credited trial', async () => {
    const group = [
      { id: 'c-1', glofox_membership_status: 'trial', trial_credits_remaining: 2, updated_at: '2026-01-01T00:00:00Z', glofox_membership_state: 'future', glofox_account_active: false },
      { id: 'c-2', glofox_membership_status: 'lead', trial_credits_remaining: 0, updated_at: '2026-08-01T00:00:00Z', glofox_membership_state: null, glofox_account_active: null },
    ]
    const res = await executeAccountTool('get_my_membership', {}, ctx(stubDb([], { contacts: group })))
    expect(res.status).toMatch(/starting soon/)
  })

  it('falls back to the most recently updated row when nothing is bookable or a credited trial (a trial with state=active is still NOT bookable)', async () => {
    const group = [
      { id: 'c-1', glofox_membership_status: 'lead', trial_credits_remaining: 0, updated_at: '2026-01-01T00:00:00Z', glofox_membership_state: 'inactive', glofox_account_active: false },
      // status 'trial' + state 'active' is NOT bookable (trial isn't in
      // MEMBER_STATUSES) — this row must win on recency alone, not on rule 1.
      { id: 'c-2', glofox_membership_status: 'trial', trial_credits_remaining: 0, updated_at: '2026-08-01T00:00:00Z', glofox_membership_state: 'active', glofox_account_active: true },
    ]
    const res = await executeAccountTool('get_my_membership', {}, ctx(stubDb([], { contacts: group })))
    // c-2 is the most recently updated (0 credits disqualifies the trial rule)
    expect(res).toEqual({ found: true, status: 'active', raw_state: 'active', account_active: true })
  })

  it('flags note_for_staff: double_membership when 2+ rows are genuinely bookable', async () => {
    const group = [
      { id: 'c-1', glofox_membership_status: 'member', updated_at: '2026-01-01T00:00:00Z', glofox_membership_state: 'active', glofox_account_active: true },
      { id: 'c-2', glofox_membership_status: 'credit_member', updated_at: '2026-02-01T00:00:00Z', glofox_membership_state: null, glofox_account_active: true },
    ]
    const res = await executeAccountTool('get_my_membership', {}, ctx(stubDb([], { contacts: group })))
    expect(res.note_for_staff).toBe('double_membership')
  })

  it('does NOT flag double_membership for one bookable row + one classpass row (even a "live" classpass account)', async () => {
    const group = [
      { id: 'c-1', glofox_membership_status: 'member', updated_at: '2026-01-01T00:00:00Z', glofox_membership_state: 'active', glofox_account_active: true },
      // A ClassPass PAYG account can itself carry state 'active', but its
      // status is 'classpass_payg' — not in MEMBER_STATUSES, so it never
      // counts as a bookable membership.
      { id: 'c-2', glofox_membership_status: 'classpass_payg', updated_at: '2026-02-01T00:00:00Z', glofox_membership_state: 'active', glofox_account_active: true },
    ]
    const res = await executeAccountTool('get_my_membership', {}, ctx(stubDb([], { contacts: group })))
    expect(res.note_for_staff).toBeUndefined()
  })

  it('readFailed → today\'s single-row behaviour, unchanged', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const group = [
      { id: 'c-1', glofox_membership_status: 'trial', updated_at: '2026-01-01T00:00:00Z', glofox_membership_state: 'future', glofox_account_active: false },
      { id: 'c-2', glofox_membership_status: 'member', updated_at: '2026-02-01T00:00:00Z', glofox_membership_state: 'active', glofox_account_active: true },
    ]
    const db = stubDb([], { contacts: group, groupReadError: { message: 'group lookup down' } })
    const res = await executeAccountTool('get_my_membership', {}, ctx(db))
    // Reads the ACTING contact (c-1) only — the sibling's bookable row must
    // never win when the group itself could not be read.
    expect(res).toEqual({ found: true, status: 'starting soon (not active yet)', raw_state: 'future', account_active: false })
    expect(res.note_for_staff).toBeUndefined()
    err.mockRestore()
  })

  // Quality-review finding: a double that ignores its select() argument
  // lets a production select silently drop a column with no test noticing
  // — the exact bug class this task exists to fix. Pin the column list
  // itself, not just the shape it happens to produce today.
  it('the final targeted re-read selects every field formatMembership needs (pins the column list)', async () => {
    const group = [
      { id: 'c-1', glofox_membership_status: 'member', updated_at: '2026-01-01T00:00:00Z', glofox_membership_state: 'active', glofox_account_active: true },
    ]
    const trace = []
    await executeAccountTool('get_my_membership', {}, ctx(stubDb(trace, { contacts: group })))
    const sel = trace.find((t) => t.step === 'select' && t.table === 'contacts' && t.cols.includes('glofox_membership_plan'))
    expect(sel).toBeTruthy()
    for (const col of ['glofox_membership_state', 'glofox_account_active', 'glofox_membership_plan', 'glofox_membership_plan_full']) {
      expect(sel.cols).toContain(col)
    }
  })
})

describe('get_my_next_class fans out across the person group', () => {
  const nowIso = '2026-08-26T12:00:00Z'
  const sec = (iso) => Math.floor(new Date(iso).getTime() / 1000)

  it('picks the soonest upcoming class across two linked contacts', async () => {
    const group = [
      { id: 'c-1', recent_bookings: [{ event_name: 'LATER', time_start: sec('2026-08-28T18:00:00Z'), status: 'BOOKED' }] },
      { id: 'c-2', recent_bookings: [{ event_name: 'SOONER', time_start: sec('2026-08-27T07:00:00Z'), status: 'BOOKED' }] },
    ]
    vi.useFakeTimers()
    vi.setSystemTime(new Date(nowIso))
    try {
      const res = await executeAccountTool('get_my_next_class', {}, ctx(stubDb([], { contacts: group })))
      expect(res.found).toBe(true)
      expect(res.class_name).toBe('SOONER')
    } finally {
      vi.useRealTimers()
    }
  })

  it('the widened .in() query receives ALL group contact ids', async () => {
    const group = [
      { id: 'c-1', recent_bookings: [] },
      { id: 'c-2', recent_bookings: [] },
      { id: 'c-3', recent_bookings: [] },
    ]
    const trace = []
    await executeAccountTool('get_my_next_class', {}, ctx(stubDb(trace, { contacts: group })))
    const call = trace.find((t) => t.step === 'in' && t.cols === 'recent_bookings')
    expect(call).toBeTruthy()
    expect(call.ids.sort()).toEqual(['c-1', 'c-2', 'c-3'])
  })

  it('readFailed → single-contact fallback, unchanged', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const group = [
      { id: 'c-1', recent_bookings: [] },
      { id: 'c-2', recent_bookings: [{ event_name: 'SIBLING ONLY', time_start: sec('2026-08-27T07:00:00Z'), status: 'BOOKED' }] },
    ]
    vi.useFakeTimers()
    vi.setSystemTime(new Date(nowIso))
    try {
      const db = stubDb([], { contacts: group, groupReadError: { message: 'group lookup down' } })
      const res = await executeAccountTool('get_my_next_class', {}, ctx(db))
      // c-1 (the acting contact) has nothing booked; the sibling's class must
      // NOT surface when the group itself could not be read.
      expect(res).toEqual({ found: false })
    } finally {
      vi.useRealTimers()
      err.mockRestore()
    }
  })
})

describe('get_my_recent_attendance fans out across the person group', () => {
  it('merges counts (sum) and last_attended (most recent) across linked contacts', async () => {
    const group = [
      { id: 'c-1', total_attended_30d: 3, total_attended_7d: 1, last_attended_at: '2026-08-01T09:00:00Z' },
      { id: 'c-2', total_attended_30d: 5, total_attended_7d: 2, last_attended_at: '2026-08-20T09:00:00Z' },
    ]
    const res = await executeAccountTool('get_my_recent_attendance', {}, ctx(stubDb([], { contacts: group })))
    expect(res).toEqual({
      found: true,
      attended_last_30d: 8,
      attended_last_7d: 3,
      last_attended: '2026-08-20T09:00:00Z',
    })
  })

  it('the widened .in() query receives ALL group contact ids', async () => {
    const group = [
      { id: 'c-1', total_attended_30d: 0, total_attended_7d: 0, last_attended_at: null },
      { id: 'c-2', total_attended_30d: 0, total_attended_7d: 0, last_attended_at: null },
    ]
    const trace = []
    await executeAccountTool('get_my_recent_attendance', {}, ctx(stubDb(trace, { contacts: group })))
    const call = trace.find((t) => t.step === 'in' && t.cols.includes('total_attended_30d'))
    expect(call).toBeTruthy()
    expect(call.ids.sort()).toEqual(['c-1', 'c-2'])
  })

  it('readFailed → single-contact fallback, unchanged', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const group = [
      { id: 'c-1', total_attended_30d: 1, total_attended_7d: 1, last_attended_at: '2026-08-01T09:00:00Z' },
      { id: 'c-2', total_attended_30d: 9, total_attended_7d: 9, last_attended_at: '2026-08-25T09:00:00Z' },
    ]
    const db = stubDb([], { contacts: group, groupReadError: { message: 'group lookup down' } })
    const res = await executeAccountTool('get_my_recent_attendance', {}, ctx(db))
    // Only c-1 (the acting contact) — the sibling's larger counts and more
    // recent date must NOT be merged in when the group could not be read.
    expect(res).toEqual({ found: true, attended_last_30d: 1, attended_last_7d: 1, last_attended: '2026-08-01T09:00:00Z' })
    err.mockRestore()
  })
})
