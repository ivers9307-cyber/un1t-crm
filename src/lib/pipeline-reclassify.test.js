// PIPELINE5.6 — orchestrator tests for reclassifyAllContacts.
// (FUNNEL.1: fixtures use the acquisition-funnel taxonomy and the
// recent_bookings / converted_at classifier inputs.)
//
// Covers the four shapes that matter for the cron:
//   1. Empty location (no contacts) → ok with zero counts
//   2. Dry-run produces movement_matrix + samples without writes
//   3. Real run groups moves by target stage and bulk-UPDATEs once
//   4. Contacts with no open deal land in createsToApply
//
// fakeDb fluent shim mirrors the one in glofox-sync.test.js — each
// db.from('table').select().eq()...  is a chainable proxy that
// records the read + records writes for assertion.

import { describe, it, expect } from 'vitest'
import { reclassifyAllContacts } from './pipeline-reclassify.js'

const isoDaysAgo = (d) => new Date(Date.now() - d * 86_400_000).toISOString()

// recent_bookings entry for an attended class `d` days ago.
// time_start is unix SECONDS (Glofox payload convention) and must be
// in the PAST for an attended booking.
const attendedBooking = (d) => ({
  status: 'BOOKED',
  attended: true,
  time_start: Math.floor((Date.now() - d * 86_400_000) / 1000),
})

// Minimal stage set covering every classifier output (FUNNEL.1
// acquisition-funnel taxonomy).
const STAGES = [
  { id: 'stage-new', slug: 'new_lead' },
  { id: 'stage-first', slug: 'first_class' },
  { id: 'stage-second', slug: 'second_class' },
  { id: 'stage-trial-done', slug: 'trial_done' },
  { id: 'stage-converted', slug: 'converted' },
  { id: 'stage-member', slug: 'member' },
  { id: 'stage-cp', slug: 'classpass' },
  { id: 'stage-dormant', slug: 'dormant' },
]

// PIPELINES.3 — the location's boards. The default is the single enabled
// derived acquisition board every location in production runs today, so the
// fixtures below (all of which predate the pipelines table) keep describing a
// real location and their assertions are unchanged.
const DEFAULT_PIPELINES = [
  { id: 'p-acq', location_id: 'loc-1', key: 'acquisition', module: 'acquisition', mode: 'derived', enabled: true, is_primary: true },
]

/**
 * @param {object} args
 * @param {object[]} [args.contacts]
 * @param {object[]} [args.deals]
 * @param {object[]} [args.stages]
 * @param {object[]} [args.pipelines]
 * @param {object} [args.runRow]   { id } returned for the audit insert
 * @returns {{ db, writes }}  writes captures every update / insert
 */
function fakeDb({
  contacts = [], deals = [], stages = STAGES,
  pipelines = DEFAULT_PIPELINES, runRow = { id: 'run-1' },
} = {}) {
  const writes = {
    runInsert: null,
    runUpdates: [],
    dealUpdates: [],
    dealInserts: [],
    // PIPELINES.3 — a flat { table, payload } log alongside the typed buckets,
    // so a test can assert a table was never written AT ALL rather than that
    // one shape of write didn't happen. That is the manual-board guarantee.
    all: [],
  }

  function chain(table, op) {
    const c = {}
    let pendingInsert = null
    let inIds = null
    let updateFields = null
    // Filters recorded for SELECTs. A filter on a column the fixture row does
    // not carry is IGNORED — most fixtures here describe only the columns
    // their own test is about (no location_id, no status, no pipeline_id) and
    // filtering them out would break every one of them.
    const filters = []
    c.select = () => c
    c.single = () => c
    c.eq = (col, val) => { filters.push({ op: 'eq', col, val }); return c }
    c.limit = () => c
    c.order = () => c
    // .range(start, end) — no-op for the shim; the .then below returns
    // the full fixture array regardless. Tests use < PAGE_SIZE rows so
    // the orchestrator's pagination loop breaks after one iteration.
    c.range = () => c
    c.in = (col, ids) => { inIds = ids; filters.push({ op: 'in', col, vals: ids }); return c }
    c.update = (fields) => { updateFields = fields; op = 'update'; return c }
    c.insert = (row) => { pendingInsert = row; op = 'insert'; return c }
    const applyFilters = (rows) => (rows || []).filter((row) => filters.every((f) => {
      if (!row || !Object.prototype.hasOwnProperty.call(row, f.col)) return true
      return f.op === 'in' ? (f.vals || []).includes(row[f.col]) : row[f.col] === f.val
    }))
    c.then = (resolve) => {
      // INSERT branch
      if (op === 'insert') {
        writes.all.push({ table, payload: pendingInsert })
        if (table === 'pipeline_classification_runs') {
          writes.runInsert = pendingInsert
          return resolve({ data: runRow, error: null })
        }
        if (table === 'deals') {
          writes.dealInserts.push(pendingInsert)
          return resolve({ data: null, error: null })
        }
      }
      // UPDATE branch
      if (op === 'update') {
        writes.all.push({ table, payload: updateFields })
        if (table === 'pipeline_classification_runs') {
          writes.runUpdates.push(updateFields)
          return resolve({ data: null, error: null })
        }
        if (table === 'deals') {
          writes.dealUpdates.push({ fields: updateFields, ids: inIds })
          return resolve({ data: null, error: null })
        }
      }
      // SELECT branch
      if (table === 'pipelines')       return resolve({ data: applyFilters(pipelines), error: null })
      if (table === 'pipeline_stages') return resolve({ data: applyFilters(stages), error: null })
      if (table === 'contacts')        return resolve({ data: applyFilters(contacts), error: null })
      if (table === 'deals')           return resolve({ data: applyFilters(deals), error: null })
      return resolve({ data: [], error: null })
    }
    return c
  }
  return {
    db: { from: (table) => chain(table, 'select') },
    writes,
  }
}

// PIPELINES.3 — the same fake, flattened: the db with its write log attached
// as db.writes ([{ table, payload }]).
function makeDb(fixtures = {}) {
  const { db, writes } = fakeDb(fixtures)
  db.writes = writes.all
  return db
}

describe('reclassifyAllContacts', () => {
  it('rejects when locationId missing', async () => {
    const { db } = fakeDb()
    const out = await reclassifyAllContacts(db, {})
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/locationId/)
  })

  it('handles a location with zero contacts', async () => {
    const { db, writes } = fakeDb({ contacts: [], deals: [] })
    const out = await reclassifyAllContacts(db, { locationId: 'loc-1' })
    expect(out.ok).toBe(true)
    expect(out.contacts_seen).toBe(0)
    expect(out.deals_moved).toBe(0)
    expect(writes.dealUpdates).toHaveLength(0)
    // Audit row opened + closed (status=success).
    expect(writes.runInsert).toMatchObject({ source: 'cron', dry_run: false })
    expect(writes.runUpdates.at(-1)).toMatchObject({ status: 'success', contacts_seen: 0 })
  })

  it('dry-run computes moves but writes nothing', async () => {
    // Freshly-converted member whose deal is still parked in new_lead
    // should move to 'converted' (converted_at 10d ago, inside the
    // 60d window). Exercises the FUNNEL.1 converted_at read — without
    // it the classifier would say 'member' instead.
    const contacts = [{
      id: 'c1', name: 'Member A', email: 'a@x.com',
      glofox_membership_status: 'member',
      converted_at: isoDaysAgo(10),
      recent_bookings: [attendedBooking(12), attendedBooking(5)],
      last_attended_at: isoDaysAgo(5),
      joined_at: isoDaysAgo(40), created_at: isoDaysAgo(40),
      trial_credits_remaining: null,
    }]
    const deals = [{ id: 'd1', contact_id: 'c1', stage_id: 'stage-new' }]
    const { db, writes } = fakeDb({ contacts, deals })

    const out = await reclassifyAllContacts(db, { locationId: 'loc-1', dryRun: true })
    expect(out.ok).toBe(true)
    expect(out.deals_moved).toBe(1)
    expect(out.movement_matrix).toHaveProperty('new_lead')
    expect(out.movement_matrix.new_lead).toEqual({ converted: 1 })
    expect(out.samples).toHaveLength(1)
    // No DB writes on dry-run — not even the audit row.
    expect(writes.runInsert).toBeNull()
    expect(writes.dealUpdates).toHaveLength(0)
  })

  it('groups moves by target stage and bulk-UPDATEs once per stage', async () => {
    // Three contacts: two long-since-converted members should land in
    // 'member' (converted_at outside / never inside the 60d window),
    // one ex_member in 'dormant'. Both member deals are currently
    // parked in 'converted'.
    const contacts = [
      {
        id: 'c1', name: 'A', email: 'a@x.com',
        glofox_membership_status: 'member',
        converted_at: isoDaysAgo(120), // aged past the 60d Converted window
        recent_bookings: [attendedBooking(3)],
        last_attended_at: isoDaysAgo(3),
        joined_at: isoDaysAgo(180), created_at: isoDaysAgo(180),
      },
      {
        id: 'c2', name: 'B', email: 'b@x.com',
        glofox_membership_status: 'member',
        converted_at: null, // pre-existing member, never stamped
        recent_bookings: [attendedBooking(5)],
        last_attended_at: isoDaysAgo(5),
        joined_at: isoDaysAgo(200), created_at: isoDaysAgo(200),
      },
      {
        id: 'c3', name: 'C', email: 'c@x.com',
        glofox_membership_status: 'ex_member',
        converted_at: isoDaysAgo(700),
        recent_bookings: [attendedBooking(400)],
        last_attended_at: isoDaysAgo(400),
        joined_at: isoDaysAgo(800), created_at: isoDaysAgo(800),
      },
    ]
    const deals = [
      { id: 'd1', contact_id: 'c1', stage_id: 'stage-converted' },
      { id: 'd2', contact_id: 'c2', stage_id: 'stage-converted' },
      { id: 'd3', contact_id: 'c3', stage_id: 'stage-member' }, // wrong: should be dormant
    ]
    const { db, writes } = fakeDb({ contacts, deals })

    const out = await reclassifyAllContacts(db, { locationId: 'loc-1' })
    expect(out.ok).toBe(true)
    expect(out.contacts_seen).toBe(3)
    expect(out.deals_moved).toBe(3)
    // Two bulk UPDATEs — one for stage-member (2 deals), one for stage-dormant (1).
    expect(writes.dealUpdates).toHaveLength(2)
    const memberUpdate = writes.dealUpdates.find((u) => u.fields.stage_id === 'stage-member')
    const dormantUpdate = writes.dealUpdates.find((u) => u.fields.stage_id === 'stage-dormant')
    expect(memberUpdate.ids.sort()).toEqual(['d1', 'd2'])
    expect(dormantUpdate.ids).toEqual(['d3'])
    // Audit closed with success.
    expect(writes.runUpdates.at(-1)).toMatchObject({
      status: 'success', contacts_seen: 3, deals_moved: 3, deals_unchanged: 0,
    })
  })

  it('creates a deal for a contact with no open deal', async () => {
    // Fresh lead (joined 5d ago, 0 classes attended) with no deal row
    // yet → orchestrator creates one in new_lead.
    const contacts = [{
      id: 'c1', name: 'New Lead', email: 'nl@x.com',
      glofox_membership_status: null,
      converted_at: null, recent_bookings: [],
      last_attended_at: null,
      joined_at: isoDaysAgo(5), created_at: isoDaysAgo(5),
      trial_credits_remaining: null,
    }]
    const { db, writes } = fakeDb({ contacts, deals: [] })
    const out = await reclassifyAllContacts(db, { locationId: 'loc-1' })
    expect(out.ok).toBe(true)
    expect(out.deals_created).toBe(1)
    expect(writes.dealInserts).toHaveLength(1)
    expect(writes.dealInserts[0]).toMatchObject({
      contact_id: 'c1', location_id: 'loc-1', status: 'open',
      stage_id: 'stage-new',
    })
  })

  it('counts unchanged when classifier matches current stage', async () => {
    // Mid-trial lead (2 classes attended, active) already in
    // second_class, classifier agrees → unchanged. Exercises the
    // FUNNEL.1 recent_bookings attended count — without it the
    // nightly run would see attended≈0 and drag the deal back.
    const contacts = [{
      id: 'c1', name: 'Trial Lead', email: 'tl@x.com',
      glofox_membership_status: null,
      converted_at: null,
      recent_bookings: [attendedBooking(10), attendedBooking(3)],
      last_attended_at: isoDaysAgo(3),
      joined_at: isoDaysAgo(20), created_at: isoDaysAgo(20),
    }]
    const deals = [{ id: 'd1', contact_id: 'c1', stage_id: 'stage-second' }]
    const { db, writes } = fakeDb({ contacts, deals })

    const out = await reclassifyAllContacts(db, { locationId: 'loc-1' })
    expect(out.ok).toBe(true)
    expect(out.deals_unchanged).toBe(1)
    expect(out.deals_moved).toBe(0)
    expect(writes.dealUpdates).toHaveLength(0) // no UPDATE issued
  })
})

describe('PIPELINES.3 — per-pipeline orchestration', () => {
  // THE test of this whole change. A manual board the classifier can see is a
  // board whose every staff move is reverted overnight — the exact failure
  // FUNNEL.1 removed drag-drop to prevent.
  it('never reads or writes a manual pipeline', async () => {
    const db = makeDb({
      pipelines: [
        { id: 'p-manual', location_id: 'loc-1', key: 'waitlist', module: null, mode: 'manual', enabled: true, is_primary: true },
      ],
      stages: [{ id: 's-1', slug: 'waitlist_new_enquiry', pipeline_id: 'p-manual' }],
      contacts: [{ id: 'c-1', name: 'Ada', glofox_membership_status: null }],
      deals: [{ id: 'd-1', contact_id: 'c-1', stage_id: 's-1', pipeline_id: 'p-manual', status: 'open' }],
    })

    const res = await reclassifyAllContacts(db, { locationId: 'loc-1', dryRun: true })

    expect(res.ok).toBe(true)
    expect(res.deals_moved).toBe(0)
    expect(res.pipelines_skipped).toContain('waitlist')
    expect(db.writes.filter((w) => w.table === 'deals')).toHaveLength(0)
  })

  it('skips a derived pipeline whose module is not registered, and reports it', async () => {
    const db = makeDb({
      pipelines: [
        { id: 'p-ret', location_id: 'loc-1', key: 'returning', module: 'returning', mode: 'derived', enabled: true, is_primary: false },
      ],
      stages: [{ id: 's-r', slug: 'returning_booked', pipeline_id: 'p-ret' }],
      contacts: [{ id: 'c-1', name: 'Ada' }],
      deals: [],
    })

    const res = await reclassifyAllContacts(db, { locationId: 'loc-1', dryRun: true })

    expect(res.ok).toBe(true)
    expect(res.pipelines_skipped).toContain('returning')
  })

  it('skips a disabled pipeline', async () => {
    const db = makeDb({
      pipelines: [
        { id: 'p-off', location_id: 'loc-1', key: 'acquisition', module: 'acquisition', mode: 'derived', enabled: false, is_primary: true },
      ],
      stages: [{ id: 's-1', slug: 'new_lead', pipeline_id: 'p-off' }],
      contacts: [{ id: 'c-1', name: 'Ada' }],
      deals: [],
    })

    const res = await reclassifyAllContacts(db, { locationId: 'loc-1', dryRun: true })

    expect(res.contacts_seen).toBe(0)
    expect(res.deals_created).toBe(0)
  })
})
