import { describe, it, expect } from 'vitest'
import { normalisePhone9, normaliseName, pickPrimary } from './person-links'

describe('normalisePhone9', () => {
  it('reduces Irish formats to the last 9 digits', () => {
    expect(normalisePhone9('087 123 4567')).toBe('871234567')
    expect(normalisePhone9('+353 87 123 4567')).toBe('871234567')
    expect(normalisePhone9('00353871234567')).toBe('871234567')
  })
  it('returns null for unusable input', () => {
    expect(normalisePhone9('')).toBeNull()
    expect(normalisePhone9('123')).toBeNull()
  })
})

describe('normaliseName', () => {
  it('lowercases, trims, collapses spaces, strips accents', () => {
    expect(normaliseName('  Aoife   Byrne ')).toBe('aoife byrne')
  })
  it('returns empty string for unusable input', () => {
    expect(normaliseName('')).toBe('')
    expect(normaliseName(null)).toBe('')
  })
})

describe('pickPrimary', () => {
  const real = { id: 'r', glofox_membership_status: 'member', glofox_account_active: true, last_attended_at: '2026-05-01' }
  const cp = { id: 'c', glofox_membership_status: 'classpass_payg', glofox_account_active: true }
  const dormant = { id: 'd', glofox_membership_status: 'member', glofox_account_active: false }
  it('prefers a real active member over a ClassPass shadow', () => {
    expect(pickPrimary([cp, real]).id).toBe('r')
  })
  it('prefers active over dormant when both are member-status', () => {
    expect(pickPrimary([dormant, real]).id).toBe('r')
  })
  it('never picks ClassPass when any non-classpass exists', () => {
    expect(pickPrimary([cp, dormant]).id).toBe('d')
  })
})

// ---------------------------------------------------------------------------
// Part B — IO group-CRUD helpers (mocked db)
// ---------------------------------------------------------------------------

import {
  createGroup,
  addToGroup,
  removeFromGroup,
  setPrimary,
  getPersonGroup,
} from './person-links'

// Chainable Supabase mock — mirrors the pattern from churn-radar-data.test.js.
// Tables is a plain-object map: tableName → rows[] or fn(state) → rows[].
// Supports insert (appends to table), update, delete, select, eq, single,
// maybeSingle. For tests that expect a specific insert result, pass a fn that
// intercepts the `insert` call and returns the desired row.
function makeDb(tables = {}) {
  // Mutable store so inserts/updates/deletes are visible to subsequent calls.
  const store = {}
  for (const [k, v] of Object.entries(tables)) {
    store[k] = typeof v === 'function' ? v : [...v]
  }

  function builder(table) {
    const state = {
      table,
      op: 'select', // select | insert | update | delete
      filters: [],  // [{ col, val }]
      payload: null,
      single: false,
      maybeSingle: false,
      selectCols: '*',
    }

    function resolve() {
      let src = store[state.table]
      if (!src) src = []
      // handle function-based tables
      const rows = typeof src === 'function' ? src(state) : src

      if (state.op === 'select') {
        let result = rows.filter(row => {
          return state.filters.every(f => {
            if (f.type === 'in') return f.vals.includes(row[f.col])
            return row[f.col] === f.val
          })
        })
        if (state.single) return { data: result[0] || null, error: null }
        if (state.maybeSingle) return { data: result[0] || null, error: null }
        return { data: result, error: null }
      }

      if (state.op === 'insert') {
        const inserted = Array.isArray(state.payload) ? state.payload : [state.payload]
        // Push into the mutable store
        if (!Array.isArray(store[state.table])) store[state.table] = []
        store[state.table].push(...inserted)
        if (state.single) return { data: inserted[0] || null, error: null }
        return { data: inserted, error: null }
      }

      if (state.op === 'update') {
        if (!Array.isArray(store[state.table])) store[state.table] = []
        const matchFn = (row) => state.filters.every(f => {
          if (f.type === 'in') return f.vals.includes(row[f.col])
          return row[f.col] === f.val
        })
        store[state.table] = store[state.table].map(row => {
          return matchFn(row) ? { ...row, ...state.payload } : row
        })
        const updated = store[state.table].filter(matchFn)
        if (state.single) return { data: updated[0] || null, error: null }
        return { data: updated, error: null }
      }

      if (state.op === 'delete') {
        if (!Array.isArray(store[state.table])) store[state.table] = []
        store[state.table] = store[state.table].filter(row => {
          return !state.filters.every(f => {
            if (f.type === 'in') return f.vals.includes(row[f.col])
            return row[f.col] === f.val
          })
        })
        return { data: null, error: null }
      }

      return { data: null, error: null }
    }

    const b = {
      select(cols) { state.selectCols = cols || '*'; return b },
      insert(payload) { state.op = 'insert'; state.payload = payload; return b },
      update(payload) { state.op = 'update'; state.payload = payload; return b },
      delete() { state.op = 'delete'; return b },
      eq(col, val) { state.filters.push({ col, val, type: 'eq' }); return b },
      in(col, vals) { state.filters.push({ col, vals, type: 'in' }); return b },
      order() { return b },
      single() { state.single = true; return b },
      maybeSingle() { state.maybeSingle = true; return b },
      limit() { return b },
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
// createGroup
// ---------------------------------------------------------------------------
describe('createGroup', () => {
  it('inserts a group row with primary_contact_id chosen by pickPrimary, and N member rows', async () => {
    const contacts = [
      { id: 'c1', glofox_membership_status: 'classpass_payg', glofox_account_active: true, last_attended_at: null },
      { id: 'c2', glofox_membership_status: 'member', glofox_account_active: true, last_attended_at: '2026-05-01' },
    ]
    const db = makeDb({ contacts, person_groups: [], person_group_members: [] })

    const { group, members } = await createGroup(db, {
      contactIds: ['c1', 'c2'],
      method: 'phone',
      confidence: 0.95,
      actorId: 'actor-1',
      locationId: 'loc-1',
      note: 'test group',
    })

    // pickPrimary should pick c2 (member beats classpass)
    expect(group.primary_contact_id).toBe('c2')
    expect(group.location_id).toBe('loc-1')
    expect(members).toHaveLength(2)
    expect(members.map(m => m.contact_id).sort()).toEqual(['c1', 'c2'])
    expect(members[0].match_method).toBe('phone')
    expect(members[0].confidence).toBe(0.95)
  })
})

// ---------------------------------------------------------------------------
// removeFromGroup
// ---------------------------------------------------------------------------
describe('removeFromGroup', () => {
  it('deletes the group entirely when only one member would remain', async () => {
    const db = makeDb({
      contacts: [
        { id: 'c1', glofox_membership_status: 'member', glofox_account_active: true, last_attended_at: null },
        { id: 'c2', glofox_membership_status: 'member', glofox_account_active: true, last_attended_at: null },
      ],
      person_groups: [
        { id: 'g1', location_id: 'loc-1', primary_contact_id: 'c1', created_by: 'actor-1', note: null },
      ],
      person_group_members: [
        { id: 'm1', group_id: 'g1', contact_id: 'c1', match_method: 'phone', confidence: 0.9, added_by: 'actor-1' },
        { id: 'm2', group_id: 'g1', contact_id: 'c2', match_method: 'phone', confidence: 0.9, added_by: 'actor-1' },
      ],
    })

    const result = await removeFromGroup(db, { groupId: 'g1', contactId: 'c1' })

    // Group should be deleted (null) when only 1 member would remain
    expect(result.group).toBeNull()
    expect(result.members).toHaveLength(0)
    // The group should no longer be in the store
    expect(db._store.person_groups).toHaveLength(0)
  })

  it('re-derives primary when the removed contact was primary and ≥2 remain', async () => {
    const db = makeDb({
      contacts: [
        { id: 'c1', glofox_membership_status: 'classpass_payg', glofox_account_active: true, last_attended_at: null },
        { id: 'c2', glofox_membership_status: 'member', glofox_account_active: true, last_attended_at: '2026-05-01' },
        { id: 'c3', glofox_membership_status: 'member', glofox_account_active: false, last_attended_at: null },
      ],
      person_groups: [
        { id: 'g1', location_id: 'loc-1', primary_contact_id: 'c2', created_by: 'actor-1', note: null },
      ],
      person_group_members: [
        { id: 'm1', group_id: 'g1', contact_id: 'c1', match_method: 'phone', confidence: 0.9, added_by: 'actor-1' },
        { id: 'm2', group_id: 'g1', contact_id: 'c2', match_method: 'phone', confidence: 0.9, added_by: 'actor-1' },
        { id: 'm3', group_id: 'g1', contact_id: 'c3', match_method: 'phone', confidence: 0.9, added_by: 'actor-1' },
      ],
    })

    // Remove c2 which was the primary; c1 (classpass) and c3 (dormant member) remain
    const result = await removeFromGroup(db, { groupId: 'g1', contactId: 'c2' })

    expect(result.group).not.toBeNull()
    // c3 (dormant member) should beat c1 (classpass) for primary
    expect(result.group.primary_contact_id).toBe('c3')
    expect(result.members).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// setPrimary
// ---------------------------------------------------------------------------
describe('setPrimary', () => {
  it('throws when the contact is not a member of the group', async () => {
    const db = makeDb({
      person_groups: [
        { id: 'g1', location_id: 'loc-1', primary_contact_id: 'c1', created_by: 'actor-1', note: null },
      ],
      person_group_members: [
        { id: 'm1', group_id: 'g1', contact_id: 'c1', match_method: 'phone', confidence: 0.9, added_by: 'actor-1' },
      ],
    })

    await expect(setPrimary(db, { groupId: 'g1', contactId: 'c-not-in-group' }))
      .rejects.toThrow('contact is not a member of this group')
  })

  it('updates the primary_contact_id to the given contact', async () => {
    const db = makeDb({
      contacts: [
        { id: 'c1', glofox_membership_status: 'member', glofox_account_active: true, last_attended_at: null },
        { id: 'c2', glofox_membership_status: 'member', glofox_account_active: true, last_attended_at: null },
      ],
      person_groups: [
        { id: 'g1', location_id: 'loc-1', primary_contact_id: 'c1', created_by: 'actor-1', note: null },
      ],
      person_group_members: [
        { id: 'm1', group_id: 'g1', contact_id: 'c1', match_method: 'phone', confidence: 0.9, added_by: 'actor-1' },
        { id: 'm2', group_id: 'g1', contact_id: 'c2', match_method: 'phone', confidence: 0.9, added_by: 'actor-1' },
      ],
    })

    const result = await setPrimary(db, { groupId: 'g1', contactId: 'c2' })
    expect(result.group.primary_contact_id).toBe('c2')
    expect(result.members).toHaveLength(2)
  })
})
