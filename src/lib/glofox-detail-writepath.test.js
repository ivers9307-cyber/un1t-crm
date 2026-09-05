// GLOFOX-DETAIL (2026-05-30) — the shared sync write-path
// (previewMemberSync / applyMemberSync) must persist the rich
// membership detail (plan / state / type / expiry / price / interval
// / payment / account_active / source ...) when the payload is the
// single-member GET shape (member.membership present), and must NOT
// touch those fields when the payload is the bulk LIST shape (no
// member.membership) — so the nightly list-sync can never null out
// detail captured by the webhook or the backfill.

import { describe, it, expect } from 'vitest'
import { applyMemberSync } from './glofox-sync.js'

const LOC = 'loc-1'

// Minimal table-aware chainable mock. Selects resolve to the rows we
// seed per table; insert/update terminal calls are captured.
function makeDb({ existingContact = null, stageRows = [{ id: 's1', slug: 'member' }] } = {}) {
  const captured = { inserts: { contacts: [], deals: [] }, updates: [] }
  function makeChain(table) {
    const st = { table, op: 'select' }
    const rowsForSelect = () => {
      if (st.table === 'contacts') return existingContact ? [existingContact] : []
      if (st.table === 'pipeline_stages') return stageRows
      if (st.table === 'deals') return []
      return []
    }
    const result = () => ({ data: rowsForSelect(), error: null })
    const chain = {
      select() { return chain },
      eq() { return chain },
      in() { return chain },
      not() { return chain },
      is() { return chain },
      or() { return chain },
      order() { return chain },
      range() { return chain },
      filter() { return chain },
      limit() { return Promise.resolve(result()) },
      maybeSingle() { return Promise.resolve({ data: rowsForSelect()[0] ?? null, error: null }) },
      single() {
        if (st.op === 'insert' && st.table === 'contacts') return Promise.resolve({ data: { id: 'c-new' }, error: null })
        if (st.op === 'insert' && st.table === 'deals') return Promise.resolve({ data: { id: 'd-new' }, error: null })
        return Promise.resolve({ data: rowsForSelect()[0] ?? null, error: null })
      },
      insert(payload) { st.op = 'insert'; if (captured.inserts[st.table]) captured.inserts[st.table].push(payload); return chain },
      update(payload) { st.op = 'update'; captured.updates.push({ table: st.table, payload }); return chain },
      upsert() { st.op = 'upsert'; return chain },
      then(res, rej) { return Promise.resolve(result()).then(res, rej) },
    }
    return chain
  }
  return { from: (t) => makeChain(t), _captured: captured }
}

// Single-member GET shape — carries member.membership.
function memberWithDetail(overrides = {}) {
  return {
    _id: 'm-detail',
    email: 'detail@example.com',
    first_name: 'Det',
    last_name: 'Ail',
    active: true,
    source: 'WEBPORTAL',
    membership: {
      membership_plan_name: '10 Class Pack',
      status: 'ACTIVE',
      type: 'num_classes',
      expiry_date: 1800000000,
      plan_price: 150,
      subscription: { price: 150, interval: 'month', interval_count: 3, payment_method_type_id: 'card' },
    },
    ...overrides,
  }
}

// Bulk LIST shape — no member.membership.
function memberListOnly(overrides = {}) {
  return { _id: 'm-list', email: 'list@example.com', first_name: 'Lis', last_name: 'Ten', ...overrides }
}

describe('GLOFOX-DETAIL write-path — single-member payload', () => {
  it('CREATE: insert payload carries the membership detail fields', async () => {
    const db = makeDb()
    const res = await applyMemberSync(db, LOC, memberWithDetail())
    expect(res.action).toBe('create')
    const ins = db._captured.inserts.contacts[0]
    expect(ins).toBeTruthy()
    expect(ins.glofox_membership_plan).toBe('10 Class Pack')
    expect(ins.glofox_membership_state).toBe('active')
    expect(ins.glofox_membership_type).toBe('num_classes')
    expect(ins.glofox_membership_price_cents).toBe(15000)
    expect(ins.glofox_billing_interval).toBe('3 months')
    expect(ins.glofox_payment_method).toBe('card')
    expect(ins.glofox_account_active).toBe(true)
    expect(ins.glofox_source).toBe('WEBPORTAL')
  })

  it('UPDATE: detail is diffed into changes and written to contacts', async () => {
    const existing = {
      id: 'c-1',
      glofox_member_id: 'm-detail',
      email: 'detail@example.com',
      first_name: 'Det', last_name: 'Ail',
      glofox_membership_status: 'credit_member',
      glofox_membership_plan: null,
      glofox_membership_state: null,
      glofox_membership_type: null,
      trial_credits_remaining: null,
    }
    const db = makeDb({ existingContact: existing })
    const res = await applyMemberSync(db, LOC, memberWithDetail())
    expect(res.action).toBe('update')
    expect(res.changes.glofox_membership_plan).toEqual({ from: null, to: '10 Class Pack' })
    expect(res.changes.glofox_membership_state).toEqual({ from: null, to: 'active' })
    const upd = db._captured.updates.find(u => u.table === 'contacts')
    expect(upd).toBeTruthy()
    expect(upd.payload.glofox_membership_plan).toBe('10 Class Pack')
    expect(upd.payload.glofox_membership_state).toBe('active')
    expect(upd.payload.glofox_membership_type).toBe('num_classes')
  })

  it('CANCEL-FORM.1: user_membership_id rides the detail write-path on create and update', async () => {
    const db = makeDb()
    await applyMemberSync(db, LOC, memberWithDetail({ membership: { ...memberWithDetail().membership, user_membership_id: '6a0219cfb4764c1cf687d640' } }))
    expect(db._captured.inserts.contacts[0].glofox_user_membership_id).toBe('6a0219cfb4764c1cf687d640')

    const existing = {
      id: 'c-9', glofox_member_id: 'm-detail', email: 'detail@example.com', first_name: 'Det', last_name: 'Ail',
      glofox_membership_status: 'credit_member', glofox_user_membership_id: null, trial_credits_remaining: null,
    }
    const db2 = makeDb({ existingContact: existing })
    const res = await applyMemberSync(db2, LOC, memberWithDetail({ membership: { ...memberWithDetail().membership, user_membership_id: '6a0219cfb4764c1cf687d640' } }))
    expect(res.changes.glofox_user_membership_id).toEqual({ from: null, to: '6a0219cfb4764c1cf687d640' })
    expect(db2._captured.updates.find(u => u.table === 'contacts').payload.glofox_user_membership_id).toBe('6a0219cfb4764c1cf687d640')
  })

  it('UPDATE: unchanged detail produces no detail diff (idempotent)', async () => {
    const existing = {
      id: 'c-2',
      glofox_member_id: 'm-detail',
      email: 'detail@example.com',
      first_name: 'Det', last_name: 'Ail',
      glofox_membership_status: 'credit_member',
      glofox_membership_plan: '10 Class Pack',
      glofox_membership_state: 'active',
      glofox_membership_type: 'num_classes',
      glofox_membership_price_cents: 15000,
      glofox_billing_interval: '3 months',
      glofox_payment_method: 'card',
      glofox_account_active: true,
      glofox_source: 'WEBPORTAL',
      glofox_membership_expiry: new Date(1800000000 * 1000).toISOString(),
      trial_credits_remaining: null,
    }
    const db = makeDb({ existingContact: existing })
    const res = await applyMemberSync(db, LOC, memberWithDetail())
    expect(res.action).toBe('update')
    expect('glofox_membership_plan' in res.changes).toBe(false)
    expect('glofox_membership_state' in res.changes).toBe(false)
    expect('glofox_membership_type' in res.changes).toBe(false)
  })
})

describe('GLOFOX-DETAIL write-path — bulk LIST payload (guard)', () => {
  it('CREATE: insert payload omits detail fields entirely', async () => {
    const db = makeDb()
    const res = await applyMemberSync(db, LOC, memberListOnly())
    expect(res.action).toBe('create')
    const ins = db._captured.inserts.contacts[0]
    expect(ins).toBeTruthy()
    expect('glofox_membership_plan' in ins).toBe(false)
    expect('glofox_membership_state' in ins).toBe(false)
    expect('glofox_membership_type' in ins).toBe(false)
    expect('glofox_membership_price_cents' in ins).toBe(false)
    expect('glofox_user_membership_id' in ins).toBe(false)
  })

  it('UPDATE: existing detail is preserved (no detail in changes or update)', async () => {
    const existing = {
      id: 'c-3',
      glofox_member_id: 'm-list',
      email: 'list@example.com',
      first_name: 'Lis', last_name: 'Ten',
      glofox_membership_status: 'member',
      glofox_membership_plan: '3 Month Membership',
      glofox_membership_state: 'active',
      glofox_membership_type: 'time',
      trial_credits_remaining: null,
    }
    const db = makeDb({ existingContact: existing })
    const res = await applyMemberSync(db, LOC, memberListOnly())
    expect(res.action).toBe('update')
    expect('glofox_membership_plan' in res.changes).toBe(false)
    expect('glofox_membership_state' in res.changes).toBe(false)
    const upd = db._captured.updates.find(u => u.table === 'contacts')
    if (upd) {
      expect('glofox_membership_plan' in upd.payload).toBe(false)
      expect('glofox_membership_state' in upd.payload).toBe(false)
    }
  })
})
