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

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { reclassifyAllContacts } from './pipeline-reclassify.js'
import { membershipReadsFor } from './membership/reads/index.js'
import { logWarn } from './log.js'

// HATCHPIPE.2 — the membership read seam is mocked: the un1t.online boards ask
// it for their inputs, and the contacts-input (Stillorgan) path must never ask
// it at all. supportsRead is the real one-liner.
vi.mock('./membership/reads/index.js', () => ({
  membershipReadsFor: vi.fn(),
  supportsRead: (r, key) => typeof r?.reads?.[key] === 'function',
}))
vi.mock('./log.js', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

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
// acquisition-funnel taxonomy). PIPELINES.5 — each stage carries the board it
// belongs to (the DEFAULT_PIPELINES acquisition board below), because the
// create path stamps deals.pipeline_id from the stage it places the deal in.
const STAGES = [
  { id: 'stage-new', slug: 'new_lead', pipeline_id: 'p-acq' },
  { id: 'stage-first', slug: 'first_class', pipeline_id: 'p-acq' },
  { id: 'stage-second', slug: 'second_class', pipeline_id: 'p-acq' },
  { id: 'stage-trial-done', slug: 'trial_done', pipeline_id: 'p-acq' },
  { id: 'stage-converted', slug: 'converted', pipeline_id: 'p-acq' },
  { id: 'stage-member', slug: 'member', pipeline_id: 'p-acq' },
  { id: 'stage-cp', slug: 'classpass', pipeline_id: 'p-acq' },
  { id: 'stage-dormant', slug: 'dormant', pipeline_id: 'p-acq' },
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
      // PIPELINES.5 — the create path is the DANGEROUS one. Step 4 above reads
      // deals with `.in('pipeline_id', …)` and SQL IN never matches NULL, so a
      // deal created here without a board is invisible to the next run, which
      // sees this contact as deal-less and creates ANOTHER — every night, for
      // every new lead.
      pipeline_id: 'p-acq',
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

// ---------------------------------------------------------------------------
// HATCHPIPE.2 — un1t.online-input boards (Hatch) and the dry run of a
// disabled board.
// ---------------------------------------------------------------------------

/**
 * A fake that records EVERY call: one entry per db.from(table), holding the
 * table and each chained method with its arguments. Run timestamps in the
 * audit close are replaced so the log is deterministic. SELECT filters apply
 * as in fakeDb (a filter on a column a fixture row lacks is ignored).
 */
function recordingDb(fixtures = {}) {
  const calls = []
  const norm = (v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const o = { ...v }
      if ('finished_at' in o) o.finished_at = '<iso>'
      if ('duration_ms' in o) o.duration_ms = '<ms>'
      return o
    }
    return v
  }
  function chain(table) {
    const entry = [table]
    calls.push(entry)
    let op = 'select'
    const filters = []
    const c = {}
    for (const m of ['select', 'eq', 'in', 'order', 'range', 'single', 'maybeSingle', 'limit', 'gte', 'update', 'insert']) {
      c[m] = (...args) => {
        entry.push([m, ...args.map(norm)])
        if (m === 'update' || m === 'insert') op = m
        if (m === 'eq') filters.push({ op: 'eq', col: args[0], val: args[1] })
        if (m === 'in') filters.push({ op: 'in', col: args[0], vals: args[1] })
        return c
      }
    }
    const applyFilters = (rows) => rows.filter((row) => filters.every((f) => {
      if (!Object.prototype.hasOwnProperty.call(row, f.col)) return true
      return f.op === 'in' ? f.vals.includes(row[f.col]) : row[f.col] === f.val
    }))
    c.then = (resolve) => {
      if (op === 'insert') {
        return resolve({ data: table === 'pipeline_classification_runs' ? { id: 'run-1' } : null, error: null })
      }
      if (op === 'update') return resolve({ data: null, error: null })
      return resolve({ data: applyFilters(fixtures[table] || []), error: null })
    }
    return c
  }
  const db = { from: (t) => chain(t) }
  const tables = () => calls.map((e) => e[0])
  const writesTo = (table) => calls.filter((e) => e[0] === table && e.some((x) => Array.isArray(x) && (x[0] === 'update' || x[0] === 'insert')))
  const argOf = (entry, method) => entry.find((x) => Array.isArray(x) && x[0] === method)
  return { db, calls, tables, writesTo, argOf }
}

const ISO_BASE = Date.parse('2026-10-01T00:00:00Z')
const isoBefore = (d) => new Date(ISO_BASE - d * 86_400_000).toISOString()

describe('HATCHPIPE.2 — contacts-input path is unchanged', () => {
  beforeEach(() => { vi.mocked(membershipReadsFor).mockReset(); vi.mocked(logWarn).mockClear() })

  it('Stillorgan (contacts-input board): exact from() call sequence and writes unchanged; membershipReadsFor never called; result has input_source "contacts"', async () => {
    // Recorded against the orchestrator BEFORE HATCHPIPE.2 (b31dd1fd): the
    // same fixture, the same calls in the same order, the same payloads.
    const { db, calls } = recordingDb({
      pipelines: [
        { id: 'p-acq', location_id: 'loc-st', key: 'acquisition', module: 'acquisition', mode: 'derived', enabled: true, is_primary: true },
        { id: 'p-ret', location_id: 'loc-st', key: 'returning', module: 'returning', mode: 'derived', enabled: true, is_primary: false },
      ],
      pipeline_stages: [
        { id: 's-new', slug: 'new_lead', pipeline_id: 'p-acq' },
        { id: 's-dormant', slug: 'dormant', pipeline_id: 'p-acq' },
        { id: 's-member', slug: 'member', pipeline_id: 'p-acq' },
      ],
      contacts: [
        { id: 'c-1', name: 'A', email: null, glofox_membership_status: 'ex_member', last_attended_at: isoBefore(400), joined_at: isoBefore(800), created_at: isoBefore(800), recent_bookings: [] },
        { id: 'c-2', name: null, email: null, glofox_membership_status: null, joined_at: new Date().toISOString(), created_at: new Date().toISOString(), recent_bookings: [] },
      ],
      deals: [{ id: 'd-1', contact_id: 'c-1', stage_id: 's-member', pipeline_id: 'p-acq', status: 'open' }],
    })

    const out = await reclassifyAllContacts(db, { locationId: 'loc-st', source: 'cron', userId: 'u-1' })

    expect(calls).toEqual([
      ['pipeline_classification_runs',
        ['insert', { location_id: 'loc-st', source: 'cron', dry_run: false, status: 'running', created_by: 'u-1' }],
        ['select', 'id'], ['single']],
      ['pipelines',
        ['select', 'id, key, module, mode, enabled, is_primary'],
        ['eq', 'location_id', 'loc-st'], ['eq', 'enabled', true]],
      ['pipeline_stages',
        ['select', 'id, slug, pipeline_id'],
        ['eq', 'location_id', 'loc-st'], ['in', 'pipeline_id', ['p-acq']]],
      ['contacts',
        ['select', 'id, name, email, glofox_membership_status, glofox_membership_state, glofox_membership_expiry, last_attended_at, total_attended_7d, total_attended_30d, last_payment_at, joined_at, created_at, trial_credits_remaining, recent_bookings, converted_at, pack_customer_at, pipeline_dismissed_at, gympass_member_id, last_lead_source_at'],
        ['eq', 'location_id', 'loc-st'], ['order', 'id', { ascending: true }], ['range', 0, 999]],
      ['deals',
        ['select', 'id, contact_id, stage_id'],
        ['eq', 'location_id', 'loc-st'], ['eq', 'status', 'open'], ['in', 'pipeline_id', ['p-acq']],
        ['order', 'id', { ascending: true }], ['range', 0, 999]],
      ['deals', ['update', { stage_id: 's-dormant' }], ['in', 'id', ['d-1']]],
      ['deals', ['insert', { title: 'Glofox member', contact_id: 'c-2', stage_id: 's-new', pipeline_id: 'p-acq', location_id: 'loc-st', status: 'open' }]],
      ['pipeline_classification_runs',
        ['update', {
          status: 'success', contacts_seen: 2, deals_moved: 1, deals_unchanged: 0, deals_created: 1, errors: 0,
          movement_matrix: { member: { dormant: 1 }, '': { new_lead: 1 } },
          samples: [{ contact_id: 'c-1', contact_name: 'A', from_slug: 'member', to_slug: 'dormant' }],
          finished_at: '<iso>', duration_ms: '<ms>',
        }],
        ['eq', 'id', 'run-1']],
    ])
    expect(membershipReadsFor).not.toHaveBeenCalled()
    expect(out).toMatchObject({ ok: true, input_source: 'contacts', deals_moved: 1, deals_created: 1, pipelines_skipped: ['returning'] })
    expect(out).not.toHaveProperty('unlinked')
    expect(out).not.toHaveProperty('stage_histogram') // dry runs only
  })
})

// Hatch: an enabled acquisition board on the un1t.online module, and the
// manual waitlist board beside it.
const HATCH = 'loc-hatch'
const HATCH_PIPELINES = [
  { id: 'p-h-acq', location_id: HATCH, key: 'acquisition', module: 'acquisition_un1t', mode: 'derived', enabled: true, is_primary: false },
  { id: 'p-h-wait', location_id: HATCH, key: 'waitlist', module: null, mode: 'manual', enabled: true, is_primary: true },
]
const HATCH_STAGES = [
  { id: 'h-new', slug: 'new_lead', pipeline_id: 'p-h-acq', location_id: HATCH },
  { id: 'h-first', slug: 'first_class', pipeline_id: 'p-h-acq', location_id: HATCH },
  { id: 'h-member', slug: 'member', pipeline_id: 'p-h-acq', location_id: HATCH },
  { id: 'h-dormant', slug: 'dormant', pipeline_id: 'p-h-acq', location_id: HATCH },
  { id: 'h-wait-new', slug: 'waitlist_new_enquiry', pipeline_id: 'p-h-wait', location_id: HATCH },
]
// Classifier inputs as pipelineInputs shapes them (field names are the
// classifier's vocabulary, not contacts columns).
const leadSnap = () => ({ glofox_membership_status: 'lead', recent_bookings: [], joined_at: new Date(Date.now() - 2 * 86_400_000).toISOString() })
const memberSnap = () => ({ glofox_membership_status: 'member', converted_at: isoBefore(200), recent_bookings: [attendedBooking(3)], last_attended_at: isoBefore(3), joined_at: isoBefore(300) })

function hatchInputs({ contacts, snapshots, unlinked = 2, skipped = 1 }) {
  return { success: true, data: { contacts, snapshots: new Map(snapshots), unlinked, skipped_no_contact: skipped } }
}

function seamWith(pipelineInputs, over = {}) {
  vi.mocked(membershipReadsFor).mockResolvedValue({
    source: 'un1t_online', label: 'un1t.online', state: 'configured', reads: { pipelineInputs }, error: null, capabilities: {}, ...over,
  })
}

describe('HATCHPIPE.2 — un1t.online-input boards', () => {
  beforeEach(() => { vi.mocked(membershipReadsFor).mockReset(); vi.mocked(logWarn).mockClear() })

  it('un1t location: uses pipelineInputs, never selects from contacts, issues no contacts write, creates deals titled from name or "Member"', async () => {
    const pipelineInputs = vi.fn().mockResolvedValue(hatchInputs({
      contacts: [
        { id: 'c-bea', name: 'Bea', email: 'bea@example.test', location_id: HATCH },
        { id: 'c-anon', name: null, email: null, location_id: HATCH },
        { id: 'c-mail', name: null, email: 'mail@example.test', location_id: HATCH },
      ],
      snapshots: [['c-bea', memberSnap()], ['c-anon', leadSnap()], ['c-mail', leadSnap()]],
    }))
    seamWith(pipelineInputs)
    const { db, tables, writesTo, argOf } = recordingDb({
      pipelines: HATCH_PIPELINES, pipeline_stages: HATCH_STAGES, deals: [],
    })

    const out = await reclassifyAllContacts(db, { locationId: HATCH })

    expect(membershipReadsFor).toHaveBeenCalledWith(db, HATCH)
    expect(pipelineInputs).toHaveBeenCalledTimes(1)
    expect(pipelineInputs.mock.calls[0][0]).toBe(db)
    expect(pipelineInputs.mock.calls[0][1]).toBe(HATCH)
    expect(typeof pipelineInputs.mock.calls[0][2].now).toBe('number')
    expect(tables()).not.toContain('contacts')
    expect(writesTo('contacts')).toHaveLength(0)

    const inserts = writesTo('deals').map((e) => argOf(e, 'insert')[1])
    expect(inserts.map((r) => [r.contact_id, r.title, r.stage_id])).toEqual([
      ['c-bea', 'Bea', 'h-member'],
      ['c-anon', 'Member', 'h-new'],
      ['c-mail', 'mail@example.test', 'h-new'],
    ])
    expect(out).toMatchObject({
      ok: true, input_source: 'un1t_online', contacts_seen: 3, deals_created: 3, errors: 0,
      unlinked: 2, skipped_no_contact: 1,
    })
  })

  it('un1t location: dual-studio contact gets a deal with location_id = Hatch and pipeline_id = Hatch acquisition', async () => {
    // The contact lives at Stillorgan and already holds a Stillorgan
    // acquisition deal; Hatch gets its own deal, and Stillorgan's is untouched.
    seamWith(vi.fn().mockResolvedValue(hatchInputs({
      contacts: [{ id: 'c-dual', name: 'Dual', email: null, location_id: 'loc-st' }],
      snapshots: [['c-dual', leadSnap()]],
    })))
    const { db, writesTo, argOf } = recordingDb({
      pipelines: HATCH_PIPELINES,
      pipeline_stages: HATCH_STAGES,
      deals: [{ id: 'd-st', contact_id: 'c-dual', stage_id: 's-st-member', pipeline_id: 'p-st-acq', location_id: 'loc-st', status: 'open' }],
    })

    const out = await reclassifyAllContacts(db, { locationId: HATCH })

    const dealWrites = writesTo('deals')
    expect(dealWrites).toHaveLength(1)
    expect(argOf(dealWrites[0], 'insert')[1]).toEqual({
      title: 'Dual', contact_id: 'c-dual', stage_id: 'h-new', pipeline_id: 'p-h-acq', location_id: HATCH, status: 'open',
    })
    expect(out.deals_created).toBe(1)
  })

  it('a contact with no snapshot is counted as an error, not classified', async () => {
    seamWith(vi.fn().mockResolvedValue(hatchInputs({
      contacts: [{ id: 'c-x', name: 'X', email: null, location_id: HATCH }],
      snapshots: [],
    })))
    const { db, writesTo } = recordingDb({ pipelines: HATCH_PIPELINES, pipeline_stages: HATCH_STAGES, deals: [] })

    const out = await reclassifyAllContacts(db, { locationId: HATCH })

    expect(out).toMatchObject({ ok: true, errors: 1, deals_created: 0 })
    expect(writesTo('deals')).toHaveLength(0)
  })

  const expectSkipped = (out, { db: rec, reason, state, source = 'un1t_online', err }) => {
    expect(out.ok).toBe(false)
    expect(out.error).toBe(`un1t inputs unavailable: ${reason}`)
    expect(out.input_source).toBe('un1t_online')
    expect(rec.writesTo('deals')).toHaveLength(0)
    expect(rec.tables()).not.toContain('contacts')
    const close = rec.calls.filter((e) => e[0] === 'pipeline_classification_runs').at(-1)
    expect(rec.argOf(close, 'update')[1]).toMatchObject({ status: 'failed', error_message: `un1t inputs unavailable: ${reason}` })
    expect(logWarn).toHaveBeenCalledWith('pipeline-reclassify', 'inputs unavailable', { locationId: HATCH, source, state, reason, ...(err ? { err } : {}) })
  }

  it('state unknown → audit row failed "un1t inputs unavailable: unknown", no deal write', async () => {
    seamWith(undefined, { state: 'unknown', reads: null })
    const rec = recordingDb({ pipelines: HATCH_PIPELINES, pipeline_stages: HATCH_STAGES, deals: [] })
    const out = await reclassifyAllContacts(rec.db, { locationId: HATCH })
    expectSkipped(out, { db: rec, reason: 'unknown', state: 'unknown' })
  })

  it('unconfigured un1t → skipped the same way', async () => {
    seamWith(undefined, { state: 'unconfigured', reads: null })
    const rec = recordingDb({ pipelines: HATCH_PIPELINES, pipeline_stages: HATCH_STAGES, deals: [] })
    const out = await reclassifyAllContacts(rec.db, { locationId: HATCH })
    expectSkipped(out, { db: rec, reason: 'unconfigured', state: 'unconfigured' })
  })

  it('pipelineInputs { success:false } → skipped the same way', async () => {
    seamWith(vi.fn().mockResolvedValue({ success: false, error: 'boom' }))
    const rec = recordingDb({ pipelines: HATCH_PIPELINES, pipeline_stages: HATCH_STAGES, deals: [] })
    const out = await reclassifyAllContacts(rec.db, { locationId: HATCH })
    expectSkipped(out, { db: rec, reason: 'read_failed', state: 'configured', err: 'boom' })
  })

  it('a pipelineInputs that throws is skipped the same way', async () => {
    seamWith(vi.fn().mockRejectedValue(new Error('socket hang up')))
    const rec = recordingDb({ pipelines: HATCH_PIPELINES, pipeline_stages: HATCH_STAGES, deals: [] })
    const out = await reclassifyAllContacts(rec.db, { locationId: HATCH })
    expectSkipped(out, { db: rec, reason: 'read_failed', state: 'configured', err: 'socket hang up' })
  })

  it('a long adapter error is cut to 200 characters in the log', async () => {
    seamWith(vi.fn().mockResolvedValue({ success: false, error: 'x'.repeat(5000) }))
    const rec = recordingDb({ pipelines: HATCH_PIPELINES, pipeline_stages: HATCH_STAGES, deals: [] })
    await reclassifyAllContacts(rec.db, { locationId: HATCH })
    const call = vi.mocked(logWarn).mock.calls.find((c) => c[1] === 'inputs unavailable')
    expect(call[2].err).toBe('x'.repeat(200))
  })

  it('a membershipReadsFor that throws logs a bounded cause and skips the run', async () => {
    vi.mocked(membershipReadsFor).mockRejectedValue(new Error('y'.repeat(5000)))
    const rec = recordingDb({ pipelines: HATCH_PIPELINES, pipeline_stages: HATCH_STAGES, deals: [] })
    const out = await reclassifyAllContacts(rec.db, { locationId: HATCH })
    expect(out).toMatchObject({ ok: false, error: 'un1t inputs unavailable: unknown' })
    const call = vi.mocked(logWarn).mock.calls.find((c) => c[1] === 'inputs unavailable')
    expect(call[2]).toMatchObject({ locationId: HATCH, state: 'unknown', reason: 'unknown', err: 'y'.repeat(200) })
    expect(rec.writesTo('deals')).toHaveLength(0)
  })

  it('a configured seam on another source is skipped too, never read from contacts', async () => {
    seamWith(vi.fn(), { source: 'glofox' })
    const rec = recordingDb({ pipelines: HATCH_PIPELINES, pipeline_stages: HATCH_STAGES, deals: [] })
    const out = await reclassifyAllContacts(rec.db, { locationId: HATCH })
    expectSkipped(out, { db: rec, reason: 'source_mismatch', state: 'configured', source: 'glofox' })
  })

  it('a location with a contacts board and a un1t board refuses the un1t board (mixed_input_sources) and runs the contacts board', async () => {
    const { db, tables, argOf, calls } = recordingDb({
      pipelines: [
        { id: 'p-acq', location_id: 'loc-1', key: 'acquisition', module: 'acquisition', mode: 'derived', enabled: true, is_primary: true },
        { id: 'p-un1t', location_id: 'loc-1', key: 'acquisition_hatch', module: 'acquisition_un1t', mode: 'derived', enabled: true, is_primary: false },
      ],
      pipeline_stages: STAGES,
      contacts: [{ id: 'c1', name: 'L', email: null, glofox_membership_status: null, joined_at: isoDaysAgo(2), created_at: isoDaysAgo(2), recent_bookings: [] }],
      deals: [],
    })

    const out = await reclassifyAllContacts(db, { locationId: 'loc-1', dryRun: true })

    expect(membershipReadsFor).not.toHaveBeenCalled()
    expect(tables()).toContain('contacts')
    expect(out).toMatchObject({ ok: true, input_source: 'contacts', deals_created: 1 })
    expect(out.pipelines_skipped).toContain('acquisition_hatch')
    expect(logWarn).toHaveBeenCalledWith('pipeline-reclassify', 'board refused', expect.objectContaining({
      key: 'acquisition_hatch', locationId: 'loc-1', reason: 'mixed_input_sources',
    }))
    // The un1t board's stages and deals are not read either.
    const stagesCall = calls.find((e) => e[0] === 'pipeline_stages')
    expect(argOf(stagesCall, 'in')).toEqual(['in', 'pipeline_id', ['p-acq']])
  })

  it('a pipelines row naming an unregistered module is skipped and reported', async () => {
    seamWith(vi.fn().mockResolvedValue(hatchInputs({
      contacts: [{ id: 'c-bea', name: 'Bea', email: null, location_id: HATCH }],
      snapshots: [['c-bea', leadSnap()]],
    })))
    const { db } = recordingDb({
      pipelines: [...HATCH_PIPELINES, { id: 'p-h-x', location_id: HATCH, key: 'mystery', module: 'acquisition_v9', mode: 'derived', enabled: true, is_primary: false }],
      pipeline_stages: HATCH_STAGES,
      deals: [],
    })

    const out = await reclassifyAllContacts(db, { locationId: HATCH, dryRun: true })

    expect(out).toMatchObject({ ok: true, input_source: 'un1t_online', deals_created: 1 })
    expect(out.pipelines_skipped).toEqual(expect.arrayContaining(['waitlist', 'mystery']))
    expect(logWarn).toHaveBeenCalledWith('pipeline-reclassify', 'no board module registered', { key: 'mystery', module: 'acquisition_v9', locationId: HATCH })
  })

  it('the manual waitlist board is never read or written on the un1t path', async () => {
    seamWith(vi.fn().mockResolvedValue(hatchInputs({
      contacts: [{ id: 'c-bea', name: 'Bea', email: null, location_id: HATCH }],
      snapshots: [['c-bea', memberSnap()]],
    })))
    const { db, calls, writesTo, argOf } = recordingDb({
      pipelines: HATCH_PIPELINES,
      pipeline_stages: HATCH_STAGES,
      deals: [
        { id: 'd-wait', contact_id: 'c-bea', stage_id: 'h-wait-new', pipeline_id: 'p-h-wait', location_id: HATCH, status: 'open' },
        { id: 'd-acq', contact_id: 'c-bea', stage_id: 'h-new', pipeline_id: 'p-h-acq', location_id: HATCH, status: 'open' },
      ],
    })

    const out = await reclassifyAllContacts(db, { locationId: HATCH })

    const stagesCall = calls.find((e) => e[0] === 'pipeline_stages')
    expect(argOf(stagesCall, 'in')).toEqual(['in', 'pipeline_id', ['p-h-acq']])
    const dealsRead = calls.find((e) => e[0] === 'deals' && argOf(e, 'select'))
    expect(argOf(dealsRead, 'in')).toEqual(['in', 'pipeline_id', ['p-h-acq']])
    const dealWrites = writesTo('deals')
    expect(dealWrites).toHaveLength(1)
    expect(argOf(dealWrites[0], 'update')[1]).toEqual({ stage_id: 'h-member' })
    expect(argOf(dealWrites[0], 'in')).toEqual(['in', 'id', ['d-acq']])
    expect(out).toMatchObject({ ok: true, deals_moved: 1, deals_created: 0 })
    expect(out.pipelines_skipped).toContain('waitlist')
  })
})

describe('HATCHPIPE.2 — dry run of a disabled board (includeDisabled)', () => {
  beforeEach(() => { vi.mocked(membershipReadsFor).mockReset(); vi.mocked(logWarn).mockClear() })

  // Hatch before A2: the acquisition row is disabled and still names the
  // Glofox module. The dry run treats it as acquisition_un1t.
  const DISABLED_HATCH = [
    { id: 'p-h-acq', location_id: HATCH, key: 'acquisition', module: 'acquisition', mode: 'derived', enabled: false, is_primary: false },
    { id: 'p-h-wait', location_id: HATCH, key: 'waitlist', module: null, mode: 'manual', enabled: true, is_primary: true },
  ]
  const inputs = () => hatchInputs({
    contacts: [
      { id: 'c-bea', name: 'Bea', email: null, location_id: HATCH },
      { id: 'c-cal', name: 'Cal', email: null, location_id: HATCH },
      { id: 'c-dee', name: 'Dee', email: null, location_id: 'loc-st' },
    ],
    snapshots: [['c-bea', memberSnap()], ['c-cal', leadSnap()], ['c-dee', leadSnap()]],
  })

  it('includeDisabled is ignored without dryRun; with dryRun it classifies the disabled acquisition row as acquisition_un1t and returns stage_histogram', async () => {
    // Without dryRun: one pipelines query, the disabled board stays off.
    seamWith(vi.fn().mockResolvedValue(inputs()))
    const live = recordingDb({ pipelines: DISABLED_HATCH, pipeline_stages: HATCH_STAGES, deals: [] })
    const liveOut = await reclassifyAllContacts(live.db, { locationId: HATCH, includeDisabled: ['acquisition'] })
    expect(live.tables().filter((t) => t === 'pipelines')).toHaveLength(1)
    expect(membershipReadsFor).not.toHaveBeenCalled()
    expect(live.writesTo('deals')).toHaveLength(0)
    expect(liveOut).toMatchObject({ ok: true, contacts_seen: 0, deals_created: 0 })
    expect(liveOut).not.toHaveProperty('stage_histogram')

    // With dryRun: one extra query for the disabled rows with those keys.
    const pipelineInputs = vi.fn().mockResolvedValue(inputs())
    seamWith(pipelineInputs)
    const dry = recordingDb({
      pipelines: DISABLED_HATCH,
      pipeline_stages: HATCH_STAGES,
      deals: [{ id: 'd-bea', contact_id: 'c-bea', stage_id: 'h-new', pipeline_id: 'p-h-acq', location_id: HATCH, status: 'open' }],
    })
    const out = await reclassifyAllContacts(dry.db, { locationId: HATCH, dryRun: true, includeDisabled: ['acquisition'] })

    const pipelineCalls = dry.calls.filter((e) => e[0] === 'pipelines')
    expect(pipelineCalls).toHaveLength(2)
    expect(pipelineCalls[1].slice(1)).toEqual([
      ['select', 'id, key, module, mode, enabled, is_primary'],
      ['eq', 'location_id', HATCH], ['eq', 'enabled', false], ['in', 'key', ['acquisition']],
    ])
    expect(pipelineInputs).toHaveBeenCalledTimes(1)
    expect(dry.tables()).not.toContain('contacts')
    // Dry run: nothing written anywhere, the audit row included.
    expect(dry.calls.filter((e) => e.some((x) => Array.isArray(x) && (x[0] === 'update' || x[0] === 'insert')))).toHaveLength(0)
    expect(out).toMatchObject({
      ok: true, input_source: 'un1t_online', contacts_seen: 3, deals_moved: 1, deals_created: 2,
      stage_histogram: { member: 1, new_lead: 2 },
      movement_matrix: { new_lead: { member: 1 } },
    })
    expect(out.pipelines_skipped).toEqual(['waitlist'])
  })
})
