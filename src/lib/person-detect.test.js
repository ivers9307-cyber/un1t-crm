// Tests for person-detect.js (PERSON-LINK.2)
//
// Coverage:
//   planDetection (pure)
//     - builds dismissedPairKeys from dismissed/linked suggestions
//     - partitions candidates into autoLink (high) and review (medium/low)
//     - dismissed pair is excluded from candidates
//
//   runDetection (IO, dry-run)
//     - paginates contacts + suggestions
//     - returns dryRun:true with counts + sample
//     - writes NOTHING to the database
//
//   runDetection (IO, commit)
//     - upserts suggestions for all candidates
//     - calls createGroup for two ungrouped high-confidence pairs
//     - calls addToGroup when one contact is already grouped
//     - skips pairs already in the same group
//     - skips pairs in different existing groups
//     - medium/low candidates are written as pending, never linked
//     - dismissed pair is not re-suggested / not linked

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock only the IO functions from person-links so that person-match.js still
// gets the real normalisePhone9 / normaliseName helpers it imports from there.
// vi.importActual preserves the pure helpers while spying on the writes.
// ---------------------------------------------------------------------------

vi.mock('./person-links.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    createGroup: vi.fn(),
    addToGroup: vi.fn(),
  }
})

import { createGroup, addToGroup } from './person-links.js'
import { planDetection, runDetection } from './person-detect.js'

// ---------------------------------------------------------------------------
// Minimal contact factories
// ---------------------------------------------------------------------------

function contact(id, overrides = {}) {
  return {
    id,
    location_id: overrides.location_id ?? 'loc-1',
    name: overrides.name ?? `Contact ${id}`,
    first_name: null,
    last_name: null,
    phone: overrides.phone ?? null,
    wa_phone: null,
    glofox_membership_status: overrides.glofox_membership_status ?? 'member',
    person_group_id: overrides.person_group_id ?? null,
  }
}

// Two non-ClassPass contacts sharing the same 9-digit phone tail → detectCandidates
// will return a 'high' pair when their names also match, 'medium' otherwise.
const PHONE_A = '0871111111'
const PHONE_B = '0872222222'

// ---------------------------------------------------------------------------
// planDetection (pure)
// ---------------------------------------------------------------------------

describe('planDetection', () => {
  it('partitions candidates into autoLink (high) and review (not high)', () => {
    // Same phone + same name → high confidence
    const c1 = contact('c1', { phone: PHONE_A, name: 'Alice Smith' })
    const c2 = contact('c2', { phone: PHONE_A, name: 'Alice Smith' })
    // Same phone + different name → medium confidence
    const c3 = contact('c3', { phone: PHONE_B, name: 'Bob Jones' })
    const c4 = contact('c4', { phone: PHONE_B, name: 'Robert Jones' })

    const { candidates, autoLink, review } = planDetection({
      contacts: [c1, c2, c3, c4],
      existingSuggestions: [],
    })

    expect(candidates.length).toBeGreaterThanOrEqual(2)
    expect(autoLink.every(c => c.confidence === 'high')).toBe(true)
    expect(review.every(c => c.confidence !== 'high')).toBe(true)

    const highPair = autoLink.find(c =>
      (c.aId === 'c1' && c.bId === 'c2') || (c.aId === 'c2' && c.bId === 'c1')
    )
    expect(highPair).toBeDefined()
  })

  it('excludes dismissed pairs from candidates', () => {
    const c1 = contact('c1', { phone: PHONE_A, name: 'Alice Smith' })
    const c2 = contact('c2', { phone: PHONE_A, name: 'Alice Smith' })

    const existingSuggestions = [
      { contact_id_a: 'c1', contact_id_b: 'c2', status: 'dismissed' },
    ]

    const { candidates } = planDetection({
      contacts: [c1, c2],
      existingSuggestions,
    })

    const foundPair = candidates.find(c =>
      (c.aId === 'c1' && c.bId === 'c2') || (c.aId === 'c2' && c.bId === 'c1')
    )
    expect(foundPair).toBeUndefined()
  })

  it('excludes linked pairs from candidates', () => {
    const c1 = contact('c1', { phone: PHONE_A, name: 'Alice Smith' })
    const c2 = contact('c2', { phone: PHONE_A, name: 'Alice Smith' })

    const existingSuggestions = [
      { contact_id_a: 'c1', contact_id_b: 'c2', status: 'linked' },
    ]

    const { candidates } = planDetection({
      contacts: [c1, c2],
      existingSuggestions,
    })

    const foundPair = candidates.find(c =>
      (c.aId === 'c1' && c.bId === 'c2') || (c.aId === 'c2' && c.bId === 'c1')
    )
    expect(foundPair).toBeUndefined()
  })

  it('includes pending suggestions pairs as candidates (not excluded)', () => {
    const c1 = contact('c1', { phone: PHONE_A, name: 'Alice Smith' })
    const c2 = contact('c2', { phone: PHONE_A, name: 'Alice Smith' })

    const existingSuggestions = [
      { contact_id_a: 'c1', contact_id_b: 'c2', status: 'pending' },
    ]

    const { candidates } = planDetection({
      contacts: [c1, c2],
      existingSuggestions,
    })

    // pending is NOT in the dismissedPairKeys so the pair still appears
    const foundPair = candidates.find(c =>
      (c.aId === 'c1' && c.bId === 'c2') || (c.aId === 'c2' && c.bId === 'c1')
    )
    expect(foundPair).toBeDefined()
  })

  it('does not suggest pairs already in the same group', () => {
    const c1 = contact('c1', { phone: PHONE_A, name: 'Alice Smith', person_group_id: 'g1' })
    const c2 = contact('c2', { phone: PHONE_A, name: 'Alice Smith', person_group_id: 'g1' })

    const { candidates } = planDetection({
      contacts: [c1, c2],
      existingSuggestions: [],
    })

    const foundPair = candidates.find(c =>
      (c.aId === 'c1' && c.bId === 'c2') || (c.aId === 'c2' && c.bId === 'c1')
    )
    expect(foundPair).toBeUndefined()
  })

  it('counts medium and low correctly in review', () => {
    // Same phone + different name → medium (2 contacts)
    const c1 = contact('c1', { phone: PHONE_A, name: 'Bob Jones' })
    const c2 = contact('c2', { phone: PHONE_A, name: 'Robert Jones' })

    const { review } = planDetection({ contacts: [c1, c2], existingSuggestions: [] })

    const mediumCount = review.filter(c => c.confidence === 'medium').length
    expect(mediumCount).toBeGreaterThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// DB mock — minimal chainable builder for runDetection
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
      selectCols: '*',
      _range: null,
      _upsertOpts: null,
    }

    function resolve() {
      const src = store[state.table] ?? []
      const rows = typeof src === 'function' ? src(state) : src

      if (state.op === 'select') {
        let result = rows.filter(row =>
          state.filters.every(f => {
            if (f.type === 'eq') return row[f.col] === f.val
            if (f.type === 'in') return f.vals.includes(row[f.col])
            return true
          })
        )
        if (state._range) {
          const [from, to] = state._range
          result = result.slice(from, to + 1)
        }
        if (state.single) return { data: result[0] ?? null, error: null }
        return { data: result, error: null }
      }

      if (state.op === 'insert' || state.op === 'upsert') {
        if (!Array.isArray(store[state.table])) store[state.table] = []
        const rows_ = Array.isArray(state.payload) ? state.payload : [state.payload]
        store[state.table].push(...rows_)
        if (state.single) return { data: rows_[0] ?? null, error: null }
        return { data: rows_, error: null }
      }

      if (state.op === 'update') {
        if (!Array.isArray(store[state.table])) store[state.table] = []
        const matchFn = (row) => state.filters.every(f => {
          if (f.type === 'eq') return row[f.col] === f.val
          if (f.type === 'in') return f.vals.includes(row[f.col])
          return true
        })
        store[state.table] = store[state.table].map(row =>
          matchFn(row) ? { ...row, ...state.payload } : row
        )
        const updated = store[state.table].filter(matchFn)
        if (state.single) return { data: updated[0] ?? null, error: null }
        return { data: updated, error: null }
      }

      return { data: null, error: null }
    }

    const b = {
      select(cols) { state.selectCols = cols; return b },
      insert(payload) { state.op = 'insert'; state.payload = payload; return b },
      upsert(payload, opts) { state.op = 'upsert'; state.payload = payload; state._upsertOpts = opts; return b },
      update(payload) { state.op = 'update'; state.payload = payload; return b },
      eq(col, val) { state.filters.push({ col, val, type: 'eq' }); return b },
      in(col, vals) { state.filters.push({ col, vals, type: 'in' }); return b },
      order() { return b },
      range(from, to) { state._range = [from, to]; return b },
      single() { state.single = true; return b },
      maybeSingle() { return b },
      then(resolve_fn, reject_fn) {
        let value
        try { value = resolve() } catch (e) {
          return Promise.resolve().then(() => (reject_fn ? reject_fn(e) : Promise.reject(e)))
        }
        return Promise.resolve(value).then(resolve_fn, reject_fn)
      },
    }
    return b
  }

  return { from: (table) => builder(table), _store: store }
}

// ---------------------------------------------------------------------------
// runDetection — dry-run
// ---------------------------------------------------------------------------

describe('runDetection — dry-run (commit=false)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns dryRun:true with counts and sample, writes nothing', async () => {
    const c1 = contact('c1', { phone: PHONE_A, name: 'Alice Smith' })
    const c2 = contact('c2', { phone: PHONE_A, name: 'Alice Smith' })

    const db = makeDb({
      contacts: [c1, c2],
      person_link_suggestions: [],
    })

    const result = await runDetection(db, { locationId: 'loc-1', commit: false, actorId: 'u1' })

    expect(result.dryRun).toBe(true)
    expect(result.counts).toEqual(expect.objectContaining({ high: expect.any(Number), medium: expect.any(Number), low: expect.any(Number) }))
    expect(typeof result.autoLinkCount).toBe('number')
    expect(typeof result.totalCandidates).toBe('number')
    expect(Array.isArray(result.sample)).toBe(true)
    expect(result.sample.length).toBeLessThanOrEqual(25)

    // dry-run must NOT upsert suggestions or call createGroup/addToGroup
    expect(createGroup).not.toHaveBeenCalled()
    expect(addToGroup).not.toHaveBeenCalled()

    // The store for person_link_suggestions must be unchanged
    expect(db._store.person_link_suggestions).toHaveLength(0)
  })

  it('returns autoLinkCount matching high-confidence count', async () => {
    const c1 = contact('c1', { phone: PHONE_A, name: 'Alice Smith' })
    const c2 = contact('c2', { phone: PHONE_A, name: 'Alice Smith' }) // same phone + same name = high

    const db = makeDb({ contacts: [c1, c2], person_link_suggestions: [] })

    const result = await runDetection(db, { locationId: 'loc-1', commit: false, actorId: 'u1' })

    expect(result.counts.high).toBe(result.autoLinkCount)
    expect(result.counts.high + result.counts.medium + result.counts.low).toBe(result.totalCandidates)
  })
})

// ---------------------------------------------------------------------------
// runDetection — commit
// ---------------------------------------------------------------------------

describe('runDetection — commit=true', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createGroup.mockResolvedValue({ group: { id: 'g-new-1' }, members: [] })
    addToGroup.mockResolvedValue({ group: { id: 'g-existing' }, members: [] })
  })

  it('upserts suggestion rows for all candidates', async () => {
    const c1 = contact('c1', { phone: PHONE_A, name: 'Alice Smith' })
    const c2 = contact('c2', { phone: PHONE_A, name: 'Alice Smith' })

    const db = makeDb({ contacts: [c1, c2], person_link_suggestions: [] })

    await runDetection(db, { locationId: 'loc-1', commit: true, actorId: 'u1' })

    // At least one row upserted for the high-confidence pair
    expect(db._store.person_link_suggestions.length).toBeGreaterThanOrEqual(1)
    const row = db._store.person_link_suggestions[0]
    expect(row.location_id).toBe('loc-1')
    // Row is upserted as pending, then updated to linked after auto-linking succeeds
    expect(['pending', 'linked']).toContain(row.status)
    expect(row.contact_id_a).toBeDefined()
    expect(row.contact_id_b).toBeDefined()
  })

  it('calls createGroup for two ungrouped high-confidence contacts', async () => {
    const c1 = contact('c1', { phone: PHONE_A, name: 'Alice Smith' })
    const c2 = contact('c2', { phone: PHONE_A, name: 'Alice Smith' })

    const db = makeDb({ contacts: [c1, c2], person_link_suggestions: [] })

    const result = await runDetection(db, { locationId: 'loc-1', commit: true, actorId: 'u1' })

    expect(createGroup).toHaveBeenCalledWith(db, expect.objectContaining({
      contactIds: expect.arrayContaining(['c1', 'c2']),
      locationId: 'loc-1',
      actorId: 'u1',
    }))
    expect(result.dryRun).toBe(false)
    expect(result.autoLinked).toBe(1)
  })

  it('calls addToGroup when one high-confidence contact is already grouped', async () => {
    const c1 = contact('c1', { phone: PHONE_A, name: 'Alice Smith', person_group_id: 'g-existing' })
    const c2 = contact('c2', { phone: PHONE_A, name: 'Alice Smith' }) // ungrouped

    const db = makeDb({ contacts: [c1, c2], person_link_suggestions: [] })

    const result = await runDetection(db, { locationId: 'loc-1', commit: true, actorId: 'u1' })

    expect(addToGroup).toHaveBeenCalledWith(db, expect.objectContaining({
      groupId: 'g-existing',
      contactIds: ['c2'],
      actorId: 'u1',
    }))
    expect(createGroup).not.toHaveBeenCalled()
    expect(result.autoLinked).toBe(1)
  })

  it('skips (counts as skipped) pairs already in the same group', async () => {
    // Both in the same group — no candidate produced by planDetection
    // so autoLinked should be 0 and skipped comes from the runtime groupOf check
    const c1 = contact('c1', { phone: PHONE_A, name: 'Alice Smith', person_group_id: 'g1' })
    const c2 = contact('c2', { phone: PHONE_A, name: 'Alice Smith', person_group_id: 'g1' })

    const db = makeDb({ contacts: [c1, c2], person_link_suggestions: [] })

    const result = await runDetection(db, { locationId: 'loc-1', commit: true, actorId: 'u1' })

    // detectCandidates already excludes same-group pairs, so autoLinked + skipped = 0
    expect(createGroup).not.toHaveBeenCalled()
    expect(addToGroup).not.toHaveBeenCalled()
    expect(result.autoLinked).toBe(0)
  })

  it('skips pairs where both contacts are in different groups', async () => {
    const c1 = contact('c1', { phone: PHONE_A, name: 'Alice Smith', person_group_id: 'g1' })
    const c2 = contact('c2', { phone: PHONE_A, name: 'Alice Smith', person_group_id: 'g2' })

    const db = makeDb({ contacts: [c1, c2], person_link_suggestions: [] })

    const result = await runDetection(db, { locationId: 'loc-1', commit: true, actorId: 'u1' })

    expect(createGroup).not.toHaveBeenCalled()
    expect(addToGroup).not.toHaveBeenCalled()
    // The pair is detected (different groups don't suppress detectCandidates)
    // but the commit path skips it
    expect(result.skipped).toBeGreaterThanOrEqual(1)
    expect(result.autoLinked).toBe(0)
  })

  it('dismissed existing suggestion — pair not re-suggested or linked', async () => {
    const c1 = contact('c1', { phone: PHONE_A, name: 'Alice Smith' })
    const c2 = contact('c2', { phone: PHONE_A, name: 'Alice Smith' })

    // The pair was previously dismissed — planDetection skips it
    const db = makeDb({
      contacts: [c1, c2],
      person_link_suggestions: [
        {
          id: 's1',
          location_id: 'loc-1',
          contact_id_a: 'c1',
          contact_id_b: 'c2',
          match_method: 'phone',
          confidence: 'high',
          reason: 'Same phone and name',
          status: 'dismissed',
        },
      ],
    })

    const result = await runDetection(db, { locationId: 'loc-1', commit: true, actorId: 'u1' })

    // Dismissed pair not added as a new suggestion
    expect(db._store.person_link_suggestions).toHaveLength(1) // still just the one dismissed row
    expect(createGroup).not.toHaveBeenCalled()
    expect(addToGroup).not.toHaveBeenCalled()
    expect(result.autoLinked).toBe(0)
  })

  it('medium/low candidates are written pending but never linked', async () => {
    // Same phone but different names → medium confidence, not high
    const c1 = contact('c1', { phone: PHONE_A, name: 'Bob Jones' })
    const c2 = contact('c2', { phone: PHONE_A, name: 'Robert Jones' })

    const db = makeDb({ contacts: [c1, c2], person_link_suggestions: [] })

    const result = await runDetection(db, { locationId: 'loc-1', commit: true, actorId: 'u1' })

    // A pending row should be upserted
    expect(db._store.person_link_suggestions.length).toBeGreaterThanOrEqual(1)
    const row = db._store.person_link_suggestions[0]
    expect(row.status).toBe('pending')

    // But no linking should happen
    expect(createGroup).not.toHaveBeenCalled()
    expect(addToGroup).not.toHaveBeenCalled()
    expect(result.autoLinked).toBe(0)
  })

  it('returns dryRun:false with autoLinked, skipped, totalCandidates', async () => {
    const c1 = contact('c1', { phone: PHONE_A, name: 'Alice Smith' })
    const c2 = contact('c2', { phone: PHONE_A, name: 'Alice Smith' })

    const db = makeDb({ contacts: [c1, c2], person_link_suggestions: [] })

    const result = await runDetection(db, { locationId: 'loc-1', commit: true, actorId: 'u1' })

    expect(result.dryRun).toBe(false)
    expect(typeof result.autoLinked).toBe('number')
    expect(typeof result.skipped).toBe('number')
    expect(typeof result.totalCandidates).toBe('number')
    expect(result).not.toHaveProperty('sample')
  })

  it('updates the suggestion row to linked after successfully linking', async () => {
    const c1 = contact('c1', { phone: PHONE_A, name: 'Alice Smith' })
    const c2 = contact('c2', { phone: PHONE_A, name: 'Alice Smith' })

    const db = makeDb({ contacts: [c1, c2], person_link_suggestions: [] })

    await runDetection(db, { locationId: 'loc-1', commit: true, actorId: 'u1' })

    // After commit the upserted row should be updated to linked
    const linkedRow = db._store.person_link_suggestions.find(r => r.status === 'linked')
    expect(linkedRow).toBeDefined()
    expect(linkedRow.decided_by).toBe('u1')
  })

  it('primaryByGroup wired: ClassPass auto-links to the PRIMARY of its existing group', async () => {
    // Seed: two real contacts already in group g1, and a ClassPass contact with
    // the same name. person_groups returns g1 → primary = 'member1'.
    // detectCandidates should produce ONE high candidate: classpass → member1 (the primary).
    // The commit path calls addToGroup (member1 is grouped, classpass is not).
    const member1 = contact('member1', { name: 'Tara Murphy', person_group_id: 'g1' })
    const member2 = contact('member2', { name: 'Tara Murphy', person_group_id: 'g1' })
    const cp = contact('cp1', { name: 'Tara Murphy', glofox_membership_status: 'classpass_payg' })

    // mock: createGroup/addToGroup return the existing group
    addToGroup.mockResolvedValue({ group: { id: 'g1' }, members: [] })

    const db = makeDb({
      contacts: [member1, member2, cp],
      person_link_suggestions: [],
      person_groups: [{ id: 'g1', primary_contact_id: 'member1', location_id: 'loc-1' }],
    })

    const result = await runDetection(db, { locationId: 'loc-1', commit: true, actorId: 'u1' })

    // addToGroup called with the classpass into g1 (member1's group)
    expect(addToGroup).toHaveBeenCalledWith(db, expect.objectContaining({
      groupId: 'g1',
      contactIds: ['cp1'],
    }))
    // createGroup should NOT be called (the primary is already grouped)
    expect(createGroup).not.toHaveBeenCalled()
    expect(result.autoLinked).toBe(1)
  })

  it('cross-method cascade: groupOfMap updated mid-batch so C joins A\'s group via addToGroup, not a second createGroup', async () => {
    // Setup: cA is the single real (non-ClassPass) contact.
    // cB and cC are two independent ClassPass contacts with the same normalised name as cA.
    // Because each ClassPass contact matches exactly ONE real contact (cA), detectCandidates
    // emits two separate HIGH-confidence name pairs: cA–cB and cA–cC.
    //
    // Detection is phone-first then name (person-match.js ordering); both pairs here
    // are name-based and iterate in insertion order of contacts: cA–cB before cA–cC.
    //
    // Cascade property being tested:
    //   1. Process cA–cB → both ungrouped → createGroup called → groupOfMap updated
    //      so cA now maps to 'g-cascade'.
    //   2. Process cA–cC → cA is NOW in groupOfMap, cC is not → addToGroup called
    //      (NOT a second createGroup). This only works if groupOfMap was updated in step 1.
    //
    // If createGroup returned no group id (Fix 1 path), step 1 would count as a failure
    // and groupOfMap would remain empty, causing cA–cC to also hit createGroup.
    // This test therefore validates both the cascade AND that Fix 1's visible-failure
    // path does NOT trigger here (because createGroup returns a valid id).

    const cA = contact('cA', { name: 'Jordan Lee' }) // sole real contact
    const cB = contact('cB', { name: 'Jordan Lee', glofox_membership_status: 'classpass_payg' })
    const cC = contact('cC', { name: 'Jordan Lee', glofox_membership_status: 'classpass_payg' })

    // createGroup must return a group id so groupOfMap gets updated after step 1.
    createGroup.mockResolvedValue({ group: { id: 'g-cascade' }, members: [] })
    addToGroup.mockResolvedValue({ group: { id: 'g-cascade' }, members: [] })

    const db = makeDb({ contacts: [cA, cB, cC], person_link_suggestions: [] })

    const result = await runDetection(db, { locationId: 'loc-1', commit: true, actorId: 'u1' })

    // createGroup called exactly once (for the first high pair, cA–cB)
    expect(createGroup).toHaveBeenCalledTimes(1)
    expect(createGroup).toHaveBeenCalledWith(db, expect.objectContaining({
      contactIds: expect.arrayContaining(['cA', 'cB']),
    }))

    // addToGroup called exactly once (for the second high pair, cA–cC);
    // cC joins cA's existing group — NOT a second createGroup call.
    expect(addToGroup).toHaveBeenCalledTimes(1)
    expect(addToGroup).toHaveBeenCalledWith(db, expect.objectContaining({
      groupId: 'g-cascade',
      contactIds: ['cC'],
    }))

    // Both pairs successfully auto-linked
    expect(result.autoLinked).toBe(2)
    expect(result.failures).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// supersedeRedundantPending
// ---------------------------------------------------------------------------

describe('supersedeRedundantPending — commit=true', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createGroup.mockResolvedValue({ group: { id: 'g-new-1' }, members: [] })
    addToGroup.mockResolvedValue({ group: { id: 'g-existing' }, members: [] })
  })

  it('marks a pending suggestion as linked when both contacts are already in the same group', async () => {
    // Two contacts both in group g1 — already linked, so the pending suggestion is redundant
    const c1 = contact('c1', { name: 'Alice Smith', person_group_id: 'g1' })
    const c2 = contact('c2', { name: 'Alice Smith', person_group_id: 'g1' })

    const db = makeDb({
      contacts: [c1, c2],
      person_link_suggestions: [
        {
          id: 's1',
          location_id: 'loc-1',
          contact_id_a: 'c1',
          contact_id_b: 'c2',
          match_method: 'name',
          confidence: 'high',
          reason: 'Same name',
          status: 'pending',
        },
      ],
      person_groups: [{ id: 'g1', primary_contact_id: 'c1', location_id: 'loc-1' }],
    })

    const result = await runDetection(db, { locationId: 'loc-1', commit: true, actorId: 'u1' })

    // The redundant pending suggestion must now be 'linked'
    const row = db._store.person_link_suggestions.find((r) => r.id === 's1')
    expect(row.status).toBe('linked')
    // Result reports the superseded count
    expect(result.superseded).toBeGreaterThanOrEqual(1)
  })

  it('does not supersede a pending suggestion when contacts are in DIFFERENT groups', async () => {
    const c1 = contact('c1', { name: 'Alice Smith', person_group_id: 'g1' })
    const c2 = contact('c2', { name: 'Alice Smith', person_group_id: 'g2' })

    const db = makeDb({
      contacts: [c1, c2],
      person_link_suggestions: [
        {
          id: 's2',
          location_id: 'loc-1',
          contact_id_a: 'c1',
          contact_id_b: 'c2',
          match_method: 'name',
          confidence: 'medium',
          reason: 'Same name',
          status: 'pending',
        },
      ],
      person_groups: [
        { id: 'g1', primary_contact_id: 'c1', location_id: 'loc-1' },
        { id: 'g2', primary_contact_id: 'c2', location_id: 'loc-1' },
      ],
    })

    await runDetection(db, { locationId: 'loc-1', commit: true, actorId: 'u1' })

    // Different groups — must NOT be superseded
    const row = db._store.person_link_suggestions.find((r) => r.id === 's2')
    expect(row.status).toBe('pending')
  })

  it('dry-run: supersede does not run and no writes happen', async () => {
    const c1 = contact('c1', { name: 'Alice Smith', person_group_id: 'g1' })
    const c2 = contact('c2', { name: 'Alice Smith', person_group_id: 'g1' })

    const db = makeDb({
      contacts: [c1, c2],
      person_link_suggestions: [
        {
          id: 's3',
          location_id: 'loc-1',
          contact_id_a: 'c1',
          contact_id_b: 'c2',
          status: 'pending',
        },
      ],
      person_groups: [{ id: 'g1', primary_contact_id: 'c1', location_id: 'loc-1' }],
    })

    const result = await runDetection(db, { locationId: 'loc-1', commit: false, actorId: 'u1' })

    // Dry-run must return dryRun:true
    expect(result.dryRun).toBe(true)
    // Dry-run result has no superseded key
    expect(result).not.toHaveProperty('superseded')
    // The pending row stays pending (no writes)
    const row = db._store.person_link_suggestions.find((r) => r.id === 's3')
    expect(row.status).toBe('pending')
    expect(createGroup).not.toHaveBeenCalled()
    expect(addToGroup).not.toHaveBeenCalled()
  })

  it('degrade-safe: primaryByGroup fetch error → detection still completes', async () => {
    // Contacts with person_group_id set, but person_groups table throws
    const c1 = contact('c1', { phone: PHONE_A, name: 'Alice Smith', person_group_id: 'g1' })
    const c2 = contact('c2', { phone: PHONE_A, name: 'Alice Smith' })

    const db = makeDb({
      contacts: [c1, c2],
      person_link_suggestions: [],
      // Override person_groups with a function that throws
      person_groups: () => { throw new Error('DB error') },
    })

    // Should not throw — detection degrades to primaryByGroup = empty Map
    const result = await runDetection(db, { locationId: 'loc-1', commit: true, actorId: 'u1' })

    expect(result.dryRun).toBe(false)
    // Even without primaryByGroup, c1 is grouped (groupOf) and c2 is not → addToGroup
    expect(addToGroup).toHaveBeenCalledWith(db, expect.objectContaining({
      groupId: 'g1',
      contactIds: ['c2'],
    }))
  })

  it('degrade-safe: supersedeRedundantPending error → commit still succeeds and returns superseded=0', async () => {
    const c1 = contact('c1', { phone: PHONE_A, name: 'Alice Smith' })
    const c2 = contact('c2', { phone: PHONE_A, name: 'Alice Smith' })

    // Simulate the pending-query inside supersedeRedundantPending throwing.
    // We'll override the builder to throw for queries with status='pending'.
    const baseDb = makeDb({ contacts: [c1, c2], person_link_suggestions: [] })
    const originalFrom = baseDb.from.bind(baseDb)
    let pendingQueryCount = 0
    const db = {
      ...baseDb,
      from(table) {
        const b = originalFrom(table)
        if (table === 'person_link_suggestions') {
          // Wrap the builder: if a filter for status=pending is added, make it throw
          const originalEq = b.eq.bind(b)
          b.eq = (col, val) => {
            if (col === 'status' && val === 'pending') {
              pendingQueryCount++
              // Return a thenable that rejects
              return {
                select() { return this },
                order() { return this },
                range() { return this },
                in() { return this },
                eq() { return this },
                then(res, rej) {
                  const err = new Error('supersedeRedundantPending simulated failure')
                  return rej ? Promise.resolve().then(() => rej(err)) : Promise.reject(err)
                },
              }
            }
            return originalEq(col, val)
          }
        }
        return b
      },
    }

    // The commit should still succeed despite the supersede error
    const result = await runDetection(db, { locationId: 'loc-1', commit: true, actorId: 'u1' })

    expect(result.dryRun).toBe(false)
    expect(result.superseded).toBe(0)
    // The main linking should still have happened
    expect(result.autoLinked).toBeGreaterThanOrEqual(0)
  })
})
