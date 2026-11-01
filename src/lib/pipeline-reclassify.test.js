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
import { loadActiveElsewhere } from './pipeline-other-studio-members.js'
import { triggerSequencesForPipelineStageChange } from './sequences/triggers.js'

beforeEach(() => {
  vi.mocked(loadActiveElsewhere).mockReset()
  vi.mocked(loadActiveElsewhere).mockResolvedValue({ ok: true, contactIds: new Set(), reasons: new Map(), studios: [] })
})

// HATCHPIPE.2 — the membership read seam is mocked: the un1t.online boards ask
// it for their inputs, and the contacts-input (Stillorgan) path must never ask
// it at all. supportsRead is the real one-liner.
vi.mock('./membership/reads/index.js', () => ({
  membershipReadsFor: vi.fn(),
  supportsRead: (r, key) => typeof r?.reads?.[key] === 'function',
}))
vi.mock('./log.js', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
// TDSEQ.1 — the sequence trigger a un1t board move fires (triggers.test.js covers it).
vi.mock('./sequences/triggers.js', () => ({ triggerSequencesForPipelineStageChange: vi.fn() }))
// PIPEEXCL.1 — who is an active member at another studio is its own module
// (pipeline-other-studio-members.test.js); here it answers "nobody" unless a
// test says otherwise, so every fixture below keeps describing today's board.
vi.mock('./pipeline-other-studio-members.js', async (importOriginal) => ({
  ...(await importOriginal()),
  loadActiveElsewhere: vi.fn(),
}))

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
function recordingDb(fixtures = {}, { errors = {} } = {}) {
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
    for (const m of ['select', 'eq', 'in', 'order', 'range', 'single', 'maybeSingle', 'limit', 'gte', 'update', 'insert', 'upsert']) {
      c[m] = (...args) => {
        entry.push([m, ...args.map(norm)])
        if (m === 'update' || m === 'insert' || m === 'upsert') op = m
        if ((m === 'single' || m === 'maybeSingle') && op === 'select') op = 'single'
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
      // PIPE3 — a table named in `errors` fails every read, like a 500.
      if (errors[table] && op !== 'insert' && op !== 'update' && op !== 'upsert') {
        return resolve({ data: null, error: { message: errors[table] } })
      }
      if (op === 'insert') {
        return resolve({ data: table === 'pipeline_classification_runs' ? { id: 'run-1' } : null, error: null })
      }
      // An UPDATE … .select('id') answers the ids it matched, as PostgREST does
      // (PIPE3: the duplicate-deal and leave-board closes count those rows).
      if (op === 'update' && entry.some((x) => Array.isArray(x) && x[0] === 'select')) {
        const inF = filters.find((f) => f.op === 'in' && f.col === 'id')
        const eqF = filters.find((f) => f.op === 'eq' && f.col === 'id')
        const ids = inF ? inF.vals : (eqF ? [eqF.val] : [])
        return resolve({ data: ids.map((id) => ({ id })), error: null })
      }
      if (op === 'update' || op === 'upsert') return resolve({ data: null, error: null })
      const rows = applyFilters(fixtures[table] || [])
      if (op === 'single') return resolve({ data: rows[0] ?? null, error: null })
      return resolve({ data: rows, error: null })
    }
    return c
  }
  const db = { from: (t) => chain(t) }
  const tables = () => calls.map((e) => e[0])
  const writesTo = (table) => calls.filter((e) => e[0] === table && e.some((x) => Array.isArray(x) && (x[0] === 'update' || x[0] === 'insert' || x[0] === 'upsert')))
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
        // PIPE3 — pipeline_id joined the read (a cross-board move must know the board it leaves).
        ['select', 'id, contact_id, stage_id, pipeline_id'],
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
    expect(loadActiveElsewhere).toHaveBeenCalledWith(db, 'loc-st') // PIPEEXCL.2: the Glofox board reads the rule too
    expect(out).toMatchObject({ ok: true, input_source: 'contacts', deals_moved: 1, deals_created: 1, pipelines_skipped: ['returning'], deals_left_board: 0, creates_withheld: 0, other_studio_check: 'ok' })
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

function hatchInputs({ contacts, snapshots, evidence, unlinked = 2, skipped = 1 }) {
  return {
    success: true,
    data: { contacts, snapshots: new Map(snapshots), ...(evidence ? { evidence: new Map(evidence) } : {}), unlinked, skipped_no_contact: skipped },
  }
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

// HATCHPIPE.5 — a deal the un1t path CREATES carries the real dates; a MOVE
// leaves them to the mig 458 trigger (now, when the CRM saw the move).
describe('HATCHPIPE.5 — un1t create dates', () => {
  beforeEach(() => { vi.mocked(membershipReadsFor).mockReset(); vi.mocked(logWarn).mockClear() })

  const daysAgoIso = (d) => new Date(Date.now() - d * 86_400_000).toISOString()
  const leadEvidence = (createdDaysAgo) => ({
    client_created_at: daysAgoIso(createdDaysAgo), attended_starts: [], last_attended_at: null,
    joined_at: daysAgoIso(createdDaysAgo), membership_status: 'lead',
  })
  const firstClassSnap = (attendedDaysAgo) => ({
    glofox_membership_status: 'lead', recent_bookings: [attendedBooking(attendedDaysAgo)],
    last_attended_at: daysAgoIso(attendedDaysAgo), joined_at: daysAgoIso(30),
  })
  const firstClassEvidence = (attendedDaysAgo) => ({
    ...leadEvidence(30), attended_starts: [daysAgoIso(attendedDaysAgo)], last_attended_at: daysAgoIso(attendedDaysAgo),
  })

  it('a create sets created_at (client creation) and stage_entered_at (the stage evidence)', async () => {
    seamWith(vi.fn().mockResolvedValue(hatchInputs({
      contacts: [
        { id: 'c-lead', name: 'Lead', email: null, location_id: HATCH },
        { id: 'c-first', name: 'First', email: null, location_id: HATCH },
      ],
      snapshots: [['c-lead', leadSnap()], ['c-first', firstClassSnap(4)]],
      evidence: [['c-lead', leadEvidence(2)], ['c-first', firstClassEvidence(4)]],
    })))
    const { db, writesTo, argOf } = recordingDb({ pipelines: HATCH_PIPELINES, pipeline_stages: HATCH_STAGES, deals: [] })

    const out = await reclassifyAllContacts(db, { locationId: HATCH })

    const inserts = writesTo('deals').map((e) => argOf(e, 'insert')[1])
    expect(inserts).toHaveLength(2)
    const lead = inserts.find((r) => r.contact_id === 'c-lead')
    const first = inserts.find((r) => r.contact_id === 'c-first')
    expect(lead.stage_id).toBe('h-new')
    expect(Math.abs(Date.parse(lead.created_at) - (Date.now() - 2 * 86_400_000))).toBeLessThan(5_000)
    expect(lead.stage_entered_at).toBe(lead.created_at)
    expect(first.stage_id).toBe('h-first')
    expect(Math.abs(Date.parse(first.created_at) - (Date.now() - 30 * 86_400_000))).toBeLessThan(5_000)
    expect(Math.abs(Date.parse(first.stage_entered_at) - (Date.now() - 4 * 86_400_000))).toBeLessThan(5_000)
    expect(out).toMatchObject({ ok: true, deals_created: 2, errors: 0 })
  })

  it('missing stage evidence: created_at is still set, stage_entered_at is left to the column default (now)', async () => {
    seamWith(vi.fn().mockResolvedValue(hatchInputs({
      contacts: [{ id: 'c-first', name: 'First', email: null, location_id: HATCH }],
      snapshots: [['c-first', firstClassSnap(4)]],
      // the evidence knows the client but no attendance at all
      evidence: [['c-first', leadEvidence(30)]],
    })))
    const { db, writesTo, argOf } = recordingDb({ pipelines: HATCH_PIPELINES, pipeline_stages: HATCH_STAGES, deals: [] })

    await reclassifyAllContacts(db, { locationId: HATCH })

    const row = argOf(writesTo('deals')[0], 'insert')[1]
    expect(row.stage_id).toBe('h-first')
    expect(Math.abs(Date.parse(row.created_at) - (Date.now() - 30 * 86_400_000))).toBeLessThan(5_000)
    expect(row).not.toHaveProperty('stage_entered_at')
  })

  it('no evidence for the contact: the insert is exactly today\'s (both columns default to now)', async () => {
    seamWith(vi.fn().mockResolvedValue(hatchInputs({
      contacts: [{ id: 'c-lead', name: 'Lead', email: null, location_id: HATCH }],
      snapshots: [['c-lead', leadSnap()]],
      evidence: [],
    })))
    const { db, writesTo, argOf } = recordingDb({ pipelines: HATCH_PIPELINES, pipeline_stages: HATCH_STAGES, deals: [] })

    await reclassifyAllContacts(db, { locationId: HATCH })

    expect(argOf(writesTo('deals')[0], 'insert')[1]).toEqual({
      title: 'Lead', contact_id: 'c-lead', stage_id: 'h-new', pipeline_id: 'p-h-acq', location_id: HATCH, status: 'open',
    })
  })

  it('a move does NOT set either date: the update is stage_id only (the trigger stamps now)', async () => {
    seamWith(vi.fn().mockResolvedValue(hatchInputs({
      contacts: [{ id: 'c-first', name: 'First', email: null, location_id: HATCH }],
      snapshots: [['c-first', firstClassSnap(4)]],
      evidence: [['c-first', firstClassEvidence(4)]],
    })))
    const { db, writesTo, argOf } = recordingDb({
      pipelines: HATCH_PIPELINES,
      pipeline_stages: HATCH_STAGES,
      deals: [{ id: 'd-1', contact_id: 'c-first', stage_id: 'h-new', pipeline_id: 'p-h-acq', location_id: HATCH, status: 'open' }],
    })

    const out = await reclassifyAllContacts(db, { locationId: HATCH })

    const writes = writesTo('deals')
    expect(writes).toHaveLength(1)
    expect(argOf(writes[0], 'update')[1]).toEqual({ stage_id: 'h-first' })
    expect(argOf(writes[0], 'insert')).toBeUndefined()
    expect(out).toMatchObject({ ok: true, deals_moved: 1, deals_created: 0 })
  })

  it('the contacts (Stillorgan) path never sets dates, whatever a contact carries', async () => {
    const { db, writesTo, argOf } = recordingDb({
      pipelines: DEFAULT_PIPELINES,
      pipeline_stages: STAGES,
      contacts: [{ id: 'c-2', name: 'N', email: null, glofox_membership_status: null, joined_at: isoDaysAgo(40), created_at: isoDaysAgo(40), recent_bookings: [] }],
      deals: [],
    })
    await reclassifyAllContacts(db, { locationId: 'loc-1' })
    const row = argOf(writesTo('deals')[0], 'insert')[1]
    expect(Object.keys(row).sort()).toEqual(['contact_id', 'location_id', 'pipeline_id', 'stage_id', 'status', 'title'])
  })
})

// ---------------------------------------------------------------------------
// PIPEEXCL.1 — a studio's acquisition board leaves out people who are active
// members at another studio of the organisation.
// ---------------------------------------------------------------------------
describe('PIPEEXCL.1 — active members at another studio leave Hatch\'s (acquisition_un1t) board', () => {
  beforeEach(() => { vi.mocked(membershipReadsFor).mockReset(); vi.mocked(logWarn).mockClear() })

  // Records every call; a deals UPDATE answers the ids it matched (so the
  // orchestrator can count what really closed), or `closeError`.
  function exclDb(fixtures = {}, { closeError = null } = {}) {
    const calls = []
    function chain(table) {
      const entry = [table]
      calls.push(entry)
      let op = 'select'
      let inIds = null
      const filters = []
      const c = {}
      for (const m of ['select', 'eq', 'in', 'order', 'range', 'single', 'limit', 'update', 'insert']) {
        c[m] = (...args) => {
          entry.push([m, ...args])
          if (m === 'update' || m === 'insert') op = m
          if (m === 'eq') filters.push({ op: 'eq', col: args[0], val: args[1] })
          if (m === 'in') { filters.push({ op: 'in', col: args[0], vals: args[1] }); inIds = args[1] }
          return c
        }
      }
      const applyFilters = (rows) => rows.filter((row) => filters.every((f) => {
        if (!Object.prototype.hasOwnProperty.call(row, f.col)) return true
        return f.op === 'in' ? f.vals.includes(row[f.col]) : row[f.col] === f.val
      }))
      c.then = (resolve) => {
        if (op === 'insert') return resolve({ data: table === 'pipeline_classification_runs' ? { id: 'run-1' } : null, error: null })
        if (op === 'update') {
          if (table === 'deals' && entry.some((x) => x[0] === 'update' && x[1]?.status === 'lost')) {
            if (closeError) return resolve({ data: null, error: closeError })
            return resolve({ data: (inIds || []).map((id) => ({ id })), error: null })
          }
          return resolve({ data: null, error: null })
        }
        return resolve({ data: applyFilters(fixtures[table] || []), error: null })
      }
      return c
    }
    const writes = (table, method) => calls.filter((e) => e[0] === table && e.some((x) => x[0] === method))
    const arg = (entry, method) => entry.find((x) => x[0] === method)
    return { db: { from: (t) => chain(t) }, calls, writes, arg }
  }
  const elsewhere = (...ids) => vi.mocked(loadActiveElsewhere).mockResolvedValue({ ok: true, contactIds: new Set(ids), studios: [{ locationId: 'loc-st', members: ids.length }] })
  const closesIn = (rec) => rec.writes('deals', 'update').filter((e) => rec.arg(e, 'update')[1]?.status === 'lost')

  describe('Hatch (un1t.online board)', () => {
    const hatch = (contacts, snapshots, deals, opts) => {
      seamWith(vi.fn().mockResolvedValue(hatchInputs({ contacts, snapshots, unlinked: 0, skipped: 0 })))
      return exclDb({ pipelines: HATCH_PIPELINES, pipeline_stages: HATCH_STAGES, deals }, opts)
    }

    it('an active Stillorgan member\'s open Hatch deal is closed (status lost, guarded open, at this studio): never moved, never deleted', async () => {
      elsewhere('c-still')
      const rec = hatch(
        [{ id: 'c-still', name: 'Sam', email: null, location_id: 'loc-st' }],
        [['c-still', leadSnap()]],
        [{ id: 'd-h', contact_id: 'c-still', stage_id: 'h-first', pipeline_id: 'p-h-acq', location_id: HATCH, status: 'open' }],
      )

      const out = await reclassifyAllContacts(rec.db, { locationId: HATCH })

      expect(loadActiveElsewhere).toHaveBeenCalledWith(rec.db, HATCH)
      const closes = closesIn(rec)
      expect(closes).toHaveLength(1)
      expect(closes[0]).toEqual(['deals',
        ['update', { status: 'lost' }], ['in', 'id', ['d-h']], ['eq', 'location_id', HATCH], ['eq', 'status', 'open'], ['select', 'id']])
      // no stage move for it, no insert, and no delete anywhere
      expect(rec.writes('deals', 'update')).toHaveLength(1)
      expect(rec.writes('deals', 'insert')).toHaveLength(0)
      expect(rec.calls.some((e) => e.some((x) => x[0] === 'delete'))).toBe(false)
      // the contact's timeline says why
      const acts = rec.writes('activities', 'insert')
      expect(acts).toHaveLength(1)
      expect(rec.arg(acts[0], 'insert')[1]).toEqual([expect.objectContaining({
        type: 'pipeline', contact_id: 'c-still', deal_id: 'd-h', location_id: HATCH, done: true,
        subject: 'Pipeline: left the board (active member at another studio)',
      })])
      expect(out).toMatchObject({ ok: true, deals_left_board: 1, creates_withheld: 0, deals_moved: 0, deals_unchanged: 0, errors: 0, other_studio_check: 'ok' })
      expect(out.movement_matrix).toEqual({ first_class: { '(left board)': 1 } })
    })

    it('an active member elsewhere with no deal here gets none', async () => {
      elsewhere('c-still')
      const rec = hatch([{ id: 'c-still', name: 'Sam', email: null, location_id: 'loc-st' }], [['c-still', leadSnap()]], [])

      const out = await reclassifyAllContacts(rec.db, { locationId: HATCH })

      expect(rec.writes('deals', 'insert')).toHaveLength(0)
      expect(closesIn(rec)).toHaveLength(0)
      expect(out).toMatchObject({ deals_created: 0, creates_withheld: 1, deals_left_board: 0 })
    })

    it('a lapsed member elsewhere (not in the active set) is still a prospect: created and moved as today', async () => {
      elsewhere() // nobody active elsewhere
      const rec = hatch(
        [
          { id: 'c-lapsed-new', name: 'New', email: null, location_id: 'loc-st' },
          { id: 'c-lapsed-old', name: 'Old', email: null, location_id: 'loc-st' },
        ],
        [['c-lapsed-new', leadSnap()], ['c-lapsed-old', leadSnap()]],
        [{ id: 'd-old', contact_id: 'c-lapsed-old', stage_id: 'h-dormant', pipeline_id: 'p-h-acq', location_id: HATCH, status: 'open' }],
      )

      const out = await reclassifyAllContacts(rec.db, { locationId: HATCH })

      expect(closesIn(rec)).toHaveLength(0)
      expect(rec.writes('deals', 'insert')).toHaveLength(1)
      expect(out).toMatchObject({ deals_created: 1, deals_moved: 1, deals_left_board: 0, creates_withheld: 0 })
    })

    it('a member of BOTH studios keeps today\'s placement (member here)', async () => {
      elsewhere('c-both', 'c-both-new')
      const rec = hatch(
        [
          { id: 'c-both', name: 'Both', email: null, location_id: 'loc-st' },
          { id: 'c-both-new', name: 'Both new', email: null, location_id: 'loc-st' },
        ],
        [['c-both', memberSnap()], ['c-both-new', memberSnap()]],
        [{ id: 'd-both', contact_id: 'c-both', stage_id: 'h-member', pipeline_id: 'p-h-acq', location_id: HATCH, status: 'open' }],
      )

      const out = await reclassifyAllContacts(rec.db, { locationId: HATCH })

      expect(closesIn(rec)).toHaveLength(0)
      expect(rec.writes('deals', 'insert').map((e) => rec.arg(e, 'insert')[1].contact_id)).toEqual(['c-both-new'])
      expect(out).toMatchObject({ deals_unchanged: 1, deals_created: 1, deals_left_board: 0, creates_withheld: 0 })
    })

    it('the other-studio read FAILS: nothing leaves and nothing is created (the board stays as it is); moves still run; logged structurally', async () => {
      vi.mocked(loadActiveElsewhere).mockResolvedValue({ ok: false, reason: 'read_failed', studioId: 'loc-st', err: 'contacts boom' })
      const rec = hatch(
        [
          { id: 'c-a', name: 'A', email: null, location_id: 'loc-st' },
          { id: 'c-b', name: 'B', email: null, location_id: 'loc-st' },
        ],
        [['c-a', leadSnap()], ['c-b', leadSnap()]],
        [{ id: 'd-a', contact_id: 'c-a', stage_id: 'h-dormant', pipeline_id: 'p-h-acq', location_id: HATCH, status: 'open' }],
      )

      const out = await reclassifyAllContacts(rec.db, { locationId: HATCH })

      expect(closesIn(rec)).toHaveLength(0)
      expect(rec.writes('deals', 'insert')).toHaveLength(0)
      // the stage move is not about membership elsewhere, so decay keeps working
      expect(rec.writes('deals', 'update')).toHaveLength(1)
      expect(rec.arg(rec.writes('deals', 'update')[0], 'update')[1]).toEqual({ stage_id: 'h-new' })
      expect(logWarn).toHaveBeenCalledWith('pipeline-reclassify', 'other-studio members unavailable', {
        locationId: HATCH, reason: 'read_failed', studioId: 'loc-st', err: 'contacts boom', creates_held: 1,
      })
      expect(out).toMatchObject({ ok: true, other_studio_check: 'unavailable', deals_left_board: 0, deals_created: 0, creates_withheld: 0, deals_moved: 1 })
      const close = rec.calls.filter((e) => e[0] === 'pipeline_classification_runs').at(-1)
      expect(rec.arg(close, 'update')[1]).toMatchObject({ error_message: 'other-studio members unavailable: read_failed' })
    })

    it('a failed close is an error, logged, and the deal stays (no activity written)', async () => {
      elsewhere('c-still')
      const rec = hatch(
        [{ id: 'c-still', name: 'Sam', email: null, location_id: 'loc-st' }],
        [['c-still', leadSnap()]],
        [{ id: 'd-h', contact_id: 'c-still', stage_id: 'h-new', pipeline_id: 'p-h-acq', location_id: HATCH, status: 'open' }],
        { closeError: { message: 'deals boom' } },
      )

      const out = await reclassifyAllContacts(rec.db, { locationId: HATCH })

      expect(out).toMatchObject({ deals_left_board: 0, errors: 1 })
      expect(rec.writes('activities', 'insert')).toHaveLength(0)
      expect(logWarn).toHaveBeenCalledWith('pipeline-reclassify', 'leave-board chunk failed', expect.objectContaining({ err: 'deals boom', chunk_size: 1 }))
    })

    it('dry run: counts who would leave, writes nothing', async () => {
      elsewhere('c-still')
      const rec = hatch(
        [{ id: 'c-still', name: 'Sam', email: null, location_id: 'loc-st' }, { id: 'c-new', name: 'New', email: null, location_id: 'loc-st' }],
        [['c-still', leadSnap()], ['c-new', leadSnap()]],
        [{ id: 'd-h', contact_id: 'c-still', stage_id: 'h-new', pipeline_id: 'p-h-acq', location_id: HATCH, status: 'open' }],
      )
      vi.mocked(loadActiveElsewhere).mockResolvedValue({ ok: true, contactIds: new Set(['c-still', 'c-new']), studios: [] })

      const out = await reclassifyAllContacts(rec.db, { locationId: HATCH, dryRun: true })

      expect(rec.calls.filter((e) => e.some((x) => x[0] === 'update' || x[0] === 'insert'))).toHaveLength(0)
      expect(out).toMatchObject({ deals_left_board: 1, creates_withheld: 1, deals_created: 0 })
      expect(out.movement_matrix).toEqual({ new_lead: { '(left board)': 1 } })
    })

    it('the manual waitlist board is never touched, even for an active member elsewhere', async () => {
      elsewhere('c-still')
      const rec = hatch(
        [{ id: 'c-still', name: 'Sam', email: null, location_id: 'loc-st' }],
        [['c-still', leadSnap()]],
        [{ id: 'd-wait', contact_id: 'c-still', stage_id: 'h-wait-new', pipeline_id: 'p-h-wait', location_id: HATCH, status: 'open' }],
      )

      await reclassifyAllContacts(rec.db, { locationId: HATCH })

      // the deals read is scoped to the derived board, so the waitlist deal is never seen
      const dealRead = rec.calls.find((e) => e[0] === 'deals' && e.some((x) => x[0] === 'select'))
      expect(dealRead).toContainEqual(['in', 'pipeline_id', ['p-h-acq']])
      expect(closesIn(rec)).toHaveLength(0)
    })
  })

  // PIPEEXCL.2 — the rule runs on the Glofox board too (Richard, 22 Oct 2026:
  // Hatch customers and trialers were Stillorgan's New Leads), and someone
  // TRAINING elsewhere leaves with their own timeline note.
  describe('Stillorgan (Glofox board): PIPEEXCL.2 applies the rule here too', () => {
    const ST_PIPELINES = [{ id: 'p-acq', location_id: 'loc-st', key: 'acquisition', module: 'acquisition', mode: 'derived', enabled: true, is_primary: true }]
    const ST_STAGES = [
      { id: 's-new', slug: 'new_lead', pipeline_id: 'p-acq' },
      { id: 's-dormant', slug: 'dormant', pipeline_id: 'p-acq' },
      { id: 's-member', slug: 'member', pipeline_id: 'p-acq' },
    ]
    const lead = (id) => ({ id, name: id, email: null, glofox_membership_status: 'lead', joined_at: new Date().toISOString(), created_at: new Date().toISOString(), recent_bookings: [] })
    const member = (id) => ({ id, name: id, email: null, glofox_membership_status: 'member', converted_at: isoBefore(300), joined_at: isoBefore(400), created_at: isoBefore(400), recent_bookings: [] })

    it('a Hatch member and a Hatch trialer leave Stillorgan\'s board (lost + a timeline note per reason); one with no deal gets none; a member of both keeps member', async () => {
      vi.mocked(loadActiveElsewhere).mockResolvedValue({
        ok: true,
        contactIds: new Set(['c-hatch-member', 'c-hatch-trialer', 'c-hatch-new', 'c-both']),
        reasons: new Map([['c-hatch-member', 'member'], ['c-hatch-trialer', 'training'], ['c-hatch-new', 'training'], ['c-both', 'member']]),
        studios: [{ locationId: HATCH, members: 2, training: 2 }],
      })
      const rec = exclDb({
        pipelines: ST_PIPELINES, pipeline_stages: ST_STAGES,
        contacts: [lead('c-hatch-member'), lead('c-hatch-trialer'), lead('c-hatch-new'), member('c-both')],
        deals: [
          { id: 'd-1', contact_id: 'c-hatch-member', stage_id: 's-dormant', pipeline_id: 'p-acq', location_id: 'loc-st', status: 'open' },
          { id: 'd-2', contact_id: 'c-hatch-trialer', stage_id: 's-new', pipeline_id: 'p-acq', location_id: 'loc-st', status: 'open' },
          { id: 'd-3', contact_id: 'c-both', stage_id: 's-member', pipeline_id: 'p-acq', location_id: 'loc-st', status: 'open' },
        ],
      })

      const out = await reclassifyAllContacts(rec.db, { locationId: 'loc-st' })

      expect(loadActiveElsewhere).toHaveBeenCalledWith(rec.db, 'loc-st')
      const closes = closesIn(rec)
      expect(closes).toHaveLength(1)
      expect(closes[0]).toContainEqual(['in', 'id', ['d-1', 'd-2']])
      expect(rec.writes('deals', 'insert')).toHaveLength(0)
      expect(rec.calls.some((e) => e.some((x) => x[0] === 'delete'))).toBe(false)
      const acts = rec.arg(rec.writes('activities', 'insert')[0], 'insert')[1]
      expect(acts.map((a) => [a.deal_id, a.subject])).toEqual([
        ['d-1', 'Pipeline: left the board (active member at another studio)'],
        ['d-2', 'Pipeline: left the board (training at another studio)'],
      ])
      expect(acts[1].note).toMatch(/Booked or attended classes at another studio/)
      expect(acts[1]).toMatchObject({ type: 'pipeline', contact_id: 'c-hatch-trialer', location_id: 'loc-st', done: true })
      expect(out).toMatchObject({ deals_left_board: 2, creates_withheld: 1, deals_unchanged: 1, deals_created: 0, deals_moved: 0, other_studio_check: 'ok', input_source: 'contacts' })
      expect(out.movement_matrix).toEqual({ dormant: { '(left board)': 1 }, new_lead: { '(left board)': 1 } })
    })

    it('a Hatch trialer who also trains at Stillorgan stays (a prospect at both); a Hatch MEMBER who trains here still leaves', async () => {
      vi.mocked(loadActiveElsewhere).mockResolvedValue({
        ok: true,
        contactIds: new Set(['c-shara', 'c-member-here']),
        reasons: new Map([['c-shara', 'training'], ['c-member-here', 'member']]),
        trainingHere: new Set(['c-shara', 'c-member-here']),
        studios: [],
      })
      const rec = exclDb({
        pipelines: ST_PIPELINES, pipeline_stages: ST_STAGES, contacts: [lead('c-shara'), lead('c-member-here')],
        deals: [
          { id: 'd-shara', contact_id: 'c-shara', stage_id: 's-dormant', pipeline_id: 'p-acq', location_id: 'loc-st', status: 'open' },
          { id: 'd-m', contact_id: 'c-member-here', stage_id: 's-dormant', pipeline_id: 'p-acq', location_id: 'loc-st', status: 'open' },
        ],
      })
      const out = await reclassifyAllContacts(rec.db, { locationId: 'loc-st' })
      const closes = closesIn(rec)
      expect(closes).toHaveLength(1)
      expect(closes[0]).toContainEqual(['in', 'id', ['d-m']])
      // Shara's deal is classified as usual (lead → new_lead): a move, not a close
      expect(rec.writes('deals', 'update').filter((e) => rec.arg(e, 'update')[1]?.stage_id === 's-new')).toHaveLength(1)
      expect(out).toMatchObject({ deals_left_board: 1, deals_moved: 1, creates_withheld: 0 })
    })

    it('an answer without reasons (an older shape) reads as member', async () => {
      vi.mocked(loadActiveElsewhere).mockResolvedValue({ ok: true, contactIds: new Set(['c-hatch-lead']), studios: [] })
      const rec = exclDb({
        pipelines: ST_PIPELINES, pipeline_stages: ST_STAGES, contacts: [lead('c-hatch-lead')],
        deals: [{ id: 'd-1', contact_id: 'c-hatch-lead', stage_id: 's-dormant', pipeline_id: 'p-acq', location_id: 'loc-st', status: 'open' }],
      })
      await reclassifyAllContacts(rec.db, { locationId: 'loc-st' })
      const acts = rec.arg(rec.writes('activities', 'insert')[0], 'insert')[1]
      expect(acts[0].subject).toBe('Pipeline: left the board (active member at another studio)')
    })

    it('a failing other-studio read holds every create on the Glofox board too, and moves still run', async () => {
      vi.mocked(loadActiveElsewhere).mockResolvedValue({ ok: false, reason: 'read_failed', studioId: HATCH, err: 'bookings boom' })
      const rec = exclDb({
        pipelines: ST_PIPELINES, pipeline_stages: ST_STAGES, contacts: [lead('c-new'), member('c-old')],
        deals: [{ id: 'd-old', contact_id: 'c-old', stage_id: 's-dormant', pipeline_id: 'p-acq', location_id: 'loc-st', status: 'open' }],
      })
      const out = await reclassifyAllContacts(rec.db, { locationId: 'loc-st' })
      expect(rec.writes('deals', 'insert')).toHaveLength(0)
      expect(closesIn(rec)).toHaveLength(0)
      expect(rec.arg(rec.writes('deals', 'update')[0], 'update')[1]).toEqual({ stage_id: 's-member' })
      expect(out).toMatchObject({ deals_created: 0, creates_held: 1, deals_moved: 1, other_studio_check: 'unavailable' })
      expect(logWarn).toHaveBeenCalledWith('pipeline-reclassify', 'other-studio members unavailable', expect.objectContaining({ reason: 'read_failed', creates_held: 1 }))
    })
  })
})

// ---------------------------------------------------------------------------
// TDSEQ.1 — a MOVE on a un1t.online board starts the board studio's
// pipeline_stage_change sequences (Hatch's "Trial done" outreach).
// ---------------------------------------------------------------------------
describe('TDSEQ.1 — un1t board moves fire the stage-change trigger at the board\'s studio', () => {
  beforeEach(() => {
    vi.mocked(membershipReadsFor).mockReset()
    vi.mocked(logWarn).mockClear()
    vi.mocked(triggerSequencesForPipelineStageChange).mockReset()
    vi.mocked(triggerSequencesForPipelineStageChange).mockResolvedValue(undefined)
  })

  const TD_STAGES = [
    ...HATCH_STAGES,
    { id: 'h-second', slug: 'second_class', pipeline_id: 'p-h-acq', location_id: HATCH },
    { id: 'h-td', slug: 'trial_done', pipeline_id: 'p-h-acq', location_id: HATCH },
  ]
  const daysAgo = (d) => new Date(Date.now() - d * 86_400_000).toISOString()
  // 2 attended + an expired trial = trial_done on the un1t board (TRIALDONE.2).
  const trialDoneSnap = () => ({
    glofox_membership_status: 'lead', recent_bookings: [attendedBooking(9), attendedBooking(4)],
    last_attended_at: daysAgo(4), joined_at: daysAgo(30), trial_expires_at: daysAgo(1),
  })
  const firstSnap = () => ({
    glofox_membership_status: 'lead', recent_bookings: [attendedBooking(4)], last_attended_at: daysAgo(4), joined_at: daysAgo(30),
  })

  // Records every call; a deals stage UPDATE answers `moveError` when given.
  function moveDb(fixtures, { moveError = null, closedBeforeWrite = [] } = {}) {
    const calls = []
    function chain(table) {
      const entry = [table]
      calls.push(entry)
      let op = 'select'
      const filters = []
      const c = {}
      for (const m of ['select', 'eq', 'in', 'order', 'range', 'single', 'limit', 'update', 'insert']) {
        c[m] = (...args) => {
          entry.push([m, ...args])
          if (m === 'update' || m === 'insert') op = m
          if (m === 'eq') filters.push({ op: 'eq', col: args[0], val: args[1] })
          if (m === 'in') filters.push({ op: 'in', col: args[0], vals: args[1] })
          return c
        }
      }
      c.then = (resolve) => {
        if (op === 'insert') return resolve({ data: table === 'pipeline_classification_runs' ? { id: 'run-1' } : null, error: null })
        if (op === 'update') {
          const isMove = table === 'deals' && entry.some((x) => x[0] === 'update' && 'stage_id' in (x[1] || {}))
          if (isMove && moveError) return resolve({ data: null, error: moveError })
          // An update answers the ids it matched (a deal closed since the read
          // no longer matches status 'open').
          const ids = (filters.find((f) => f.op === 'in' && f.col === 'id')?.vals || [])
            .filter((id) => !closedBeforeWrite.includes(id))
          return resolve({ data: ids.map((id) => ({ id })), error: null })
        }
        const rows = (fixtures[table] || []).filter((row) => filters.every((f) => {
          if (!Object.prototype.hasOwnProperty.call(row, f.col)) return true
          return f.op === 'in' ? f.vals.includes(row[f.col]) : row[f.col] === f.val
        }))
        return resolve({ data: rows, error: null })
      }
      return c
    }
    return { db: { from: (t) => chain(t) }, calls }
  }
  const hatchRun = (people, deals, opts) => {
    seamWith(vi.fn().mockResolvedValue(hatchInputs({
      contacts: people.map(([id]) => ({ id, name: id, email: null, location_id: 'loc-st' })),
      snapshots: people,
      unlinked: 0, skipped: 0,
    })))
    return moveDb({ pipelines: HATCH_PIPELINES, pipeline_stages: TD_STAGES, deals }, opts)
  }
  const deal = (id, contactId, stageId) => ({ id, contact_id: contactId, stage_id: stageId, pipeline_id: 'p-h-acq', location_id: HATCH, status: 'open' })

  it('a move fires once, from the old slug to the new one, with the BOARD\'s studio (a Stillorgan-home contact)', async () => {
    const rec = hatchRun([['c-td', trialDoneSnap()]], [deal('d-1', 'c-td', 'h-second')])
    const out = await reclassifyAllContacts(rec.db, { locationId: HATCH })
    expect(out).toMatchObject({ ok: true, deals_moved: 1 })
    expect(triggerSequencesForPipelineStageChange).toHaveBeenCalledTimes(1)
    expect(triggerSequencesForPipelineStageChange).toHaveBeenCalledWith('c-td', 'second_class', 'trial_done', { locationId: HATCH })
  })

  it('fires after the moves are written (the deal update precedes it)', async () => {
    const order = []
    vi.mocked(triggerSequencesForPipelineStageChange).mockImplementation(async () => { order.push('trigger') })
    const rec = hatchRun([['c-td', trialDoneSnap()]], [deal('d-1', 'c-td', 'h-second')])
    const origFrom = rec.db.from
    rec.db.from = (t) => { const b = origFrom(t); const u = b.update; b.update = (...a) => { order.push(`update:${t}`); return u(...a) }; return b }
    await reclassifyAllContacts(rec.db, { locationId: HATCH })
    expect(order.indexOf('update:deals')).toBeGreaterThan(-1)
    expect(order.indexOf('trigger')).toBeGreaterThan(order.indexOf('update:deals'))
  })

  it('a create, an unchanged deal and a leave fire nothing', async () => {
    vi.mocked(loadActiveElsewhere).mockResolvedValue({ ok: true, contactIds: new Set(['c-leaver']), studios: [] })
    const rec = hatchRun(
      [['c-new', trialDoneSnap()], ['c-same', trialDoneSnap()], ['c-leaver', firstSnap()]],
      [deal('d-same', 'c-same', 'h-td'), deal('d-leave', 'c-leaver', 'h-new')],
    )
    const out = await reclassifyAllContacts(rec.db, { locationId: HATCH })
    expect(out).toMatchObject({ ok: true, deals_created: 1, deals_unchanged: 1, deals_left_board: 1, deals_moved: 0 })
    expect(triggerSequencesForPipelineStageChange).not.toHaveBeenCalled()
  })

  it('a move whose write failed fires nothing', async () => {
    const rec = hatchRun([['c-td', trialDoneSnap()]], [deal('d-1', 'c-td', 'h-second')], { moveError: { message: 'nope' } })
    const out = await reclassifyAllContacts(rec.db, { locationId: HATCH })
    expect(out).toMatchObject({ ok: true, deals_moved: 0, errors: 1 })
    expect(triggerSequencesForPipelineStageChange).not.toHaveBeenCalled()
  })

  it('a move from a stage id the run cannot name (from_slug "unknown") fires nothing: stage-id churn, not progress', async () => {
    const rec = hatchRun([['c-td', trialDoneSnap()]], [deal('d-1', 'c-td', 'h-gone')])
    const out = await reclassifyAllContacts(rec.db, { locationId: HATCH })
    expect(out).toMatchObject({ ok: true, deals_moved: 1 })
    expect(triggerSequencesForPipelineStageChange).not.toHaveBeenCalled()
  })

  it('the un1t move is guarded on status open and fires only for the rows it changed (a deal closed between read and write does not fire)', async () => {
    const rec = hatchRun(
      [['c-a', trialDoneSnap()], ['c-b', trialDoneSnap()]],
      [deal('d-a', 'c-a', 'h-second'), deal('d-b', 'c-b', 'h-second')],
      { closedBeforeWrite: ['d-a'] },
    )
    await reclassifyAllContacts(rec.db, { locationId: HATCH })
    const move = rec.calls.find((e) => e[0] === 'deals' && e.some((x) => x[0] === 'update' && 'stage_id' in (x[1] || {})))
    expect(move).toEqual(['deals', ['update', { stage_id: 'h-td' }], ['in', 'id', ['d-a', 'd-b']], ['eq', 'status', 'open'], ['select', 'id']])
    expect(triggerSequencesForPipelineStageChange).toHaveBeenCalledTimes(1)
    expect(triggerSequencesForPipelineStageChange).toHaveBeenCalledWith('c-b', 'second_class', 'trial_done', { locationId: HATCH })
  })

  it('a dry run fires nothing', async () => {
    const rec = hatchRun([['c-td', trialDoneSnap()]], [deal('d-1', 'c-td', 'h-second')])
    const out = await reclassifyAllContacts(rec.db, { locationId: HATCH, dryRun: true })
    expect(out).toMatchObject({ ok: true, deals_moved: 1 })
    expect(triggerSequencesForPipelineStageChange).not.toHaveBeenCalled()
  })

  it('more than 50 moves into one stage in a run fire none for that stage (a rule change), with a warning; other stages still fire', async () => {
    const people = []
    const deals = []
    for (let i = 0; i < 51; i++) { people.push([`c-${i}`, trialDoneSnap()]); deals.push(deal(`d-${i}`, `c-${i}`, 'h-second')) }
    people.push(['c-first', firstSnap()]); deals.push(deal('d-first', 'c-first', 'h-new'))
    const rec = hatchRun(people, deals)
    const out = await reclassifyAllContacts(rec.db, { locationId: HATCH })
    expect(out).toMatchObject({ ok: true, deals_moved: 52 })
    expect(triggerSequencesForPipelineStageChange).toHaveBeenCalledTimes(1)
    expect(triggerSequencesForPipelineStageChange).toHaveBeenCalledWith('c-first', 'new_lead', 'first_class', { locationId: HATCH })
    expect(logWarn).toHaveBeenCalledWith('pipeline-reclassify', 'stage trigger held: mass move', expect.objectContaining({ locationId: HATCH, to_slug: 'trial_done', moves: 51 }))
  })

  it('exactly 50 into one stage still fire', async () => {
    const people = []
    const deals = []
    for (let i = 0; i < 50; i++) { people.push([`c-${i}`, trialDoneSnap()]); deals.push(deal(`d-${i}`, `c-${i}`, 'h-second')) }
    const rec = hatchRun(people, deals)
    await reclassifyAllContacts(rec.db, { locationId: HATCH })
    expect(triggerSequencesForPipelineStageChange).toHaveBeenCalledTimes(50)
  })

  it('a trigger that throws never fails the run, and the rest still fire', async () => {
    vi.mocked(triggerSequencesForPipelineStageChange)
      .mockRejectedValueOnce(new Error('enrol boom'))
      .mockResolvedValue(undefined)
    const rec = hatchRun([['c-a', trialDoneSnap()], ['c-b', trialDoneSnap()]], [deal('d-a', 'c-a', 'h-second'), deal('d-b', 'c-b', 'h-second')])
    const out = await reclassifyAllContacts(rec.db, { locationId: HATCH })
    expect(out).toMatchObject({ ok: true, deals_moved: 2, errors: 0 })
    expect(triggerSequencesForPipelineStageChange).toHaveBeenCalledTimes(2)
    expect(logWarn).toHaveBeenCalledWith('pipeline-reclassify', 'stage trigger failed', expect.objectContaining({ locationId: HATCH, contactId: 'c-a' }))
  })

  it('a Glofox (contacts-input) board never fires it: that board fires through ensureDealForContact', async () => {
    const rec = moveDb({
      pipelines: DEFAULT_PIPELINES,
      pipeline_stages: STAGES,
      contacts: [{ id: 'c-1', name: 'A', email: null, glofox_membership_status: 'ex_member', last_attended_at: isoDaysAgo(400), joined_at: isoDaysAgo(800), created_at: isoDaysAgo(800), recent_bookings: [] }],
      deals: [{ id: 'd-1', contact_id: 'c-1', stage_id: 'stage-member', pipeline_id: 'p-acq', status: 'open' }],
    })
    const out = await reclassifyAllContacts(rec.db, { locationId: 'loc-1' })
    expect(out).toMatchObject({ ok: true, input_source: 'contacts', deals_moved: 1 })
    expect(triggerSequencesForPipelineStageChange).not.toHaveBeenCalled()
  })
})


// ---------------------------------------------------------------------------
// PIPE3 — three boards at one location (Stillorgan): the router places each
// contact on ONE of acquisition / paid_trial / programmes, a deal follows the
// person across boards, claims are recorded on real runs, and an unreadable
// claims read stops the run instead of moving every buyer back.
// ---------------------------------------------------------------------------
describe('PIPE3 — three boards at one location', () => {
  beforeEach(() => { vi.mocked(membershipReadsFor).mockReset(); vi.mocked(logWarn).mockClear() })

  const STILL = 'loc-st'
  const NOW = Date.now()
  const ago = (d) => new Date(NOW - d * 86_400_000).toISOString()
  const RULES = { lead_sources: ['meta_50plus'], glofox_plan_patterns: ['elites trial'] }
  const THREE = [
    { id: 'p-acq', location_id: STILL, key: 'acquisition', module: 'acquisition', mode: 'derived', enabled: true, is_primary: true },
    { id: 'p-paid', location_id: STILL, key: 'paid_trial', module: 'paid_trial', mode: 'derived', enabled: true, is_primary: false },
    { id: 'p-prog', location_id: STILL, key: 'programmes', module: 'programmes', mode: 'derived', enabled: true, is_primary: false },
  ]
  const STAGES3 = [
    ...['new_lead', 'first_class', 'second_class', 'trial_done', 'converted', 'member', 'pack_member', 'classpass', 'gympass', 'cold_lead', 'dormant']
      .map((slug) => ({ id: `s-${slug}`, slug, pipeline_id: 'p-acq', location_id: STILL })),
    ...['paid_trial_new_lead', 'paid_trial_first_class', 'paid_trial_day_7', 'paid_trial_done', 'paid_trial_converted']
      .map((slug) => ({ id: `s-${slug}`, slug, pipeline_id: 'p-paid', location_id: STILL })),
    ...['programme_lead', 'programme_first_class', 'programme_converted']
      .map((slug) => ({ id: `s-${slug}`, slug, pipeline_id: 'p-prog', location_id: STILL })),
  ]
  // The €39 buyer as prod held them on 2026-10-31: trial status, 10 credits,
  // pack-stamped minutes after the grant, filed in pack_member.
  const CONTACTS3 = [
    { id: 'c-buyer', name: 'Buyer', email: null, glofox_membership_status: 'trial', trial_credits_remaining: 10, pack_customer_at: ago(2), joined_at: ago(2), created_at: ago(2), recent_bookings: [], last_lead_source: 'meta_trial', last_lead_source_at: ago(2) },
    { id: 'c-fifty', name: 'Fifty', email: null, glofox_membership_status: 'lead', joined_at: ago(1), created_at: ago(1), recent_bookings: [], last_lead_source: 'meta_50plus', last_lead_source_at: ago(1), glofox_membership_plan: 'The Elites Trial' },
    { id: 'c-plain', name: 'Plain', email: null, glofox_membership_status: 'lead', joined_at: ago(2), created_at: ago(2), recent_bookings: [] },
  ]
  const DEALS3 = [
    { id: 'd-buyer', contact_id: 'c-buyer', stage_id: 's-pack_member', pipeline_id: 'p-acq', location_id: STILL, status: 'open' },
    { id: 'd-plain', contact_id: 'c-plain', stage_id: 's-new_lead', pipeline_id: 'p-acq', location_id: STILL, status: 'open' },
  ]
  const PURCHASES = [
    { id: 'tp-1', location_id: STILL, contact_id: 'c-buyer', status: 'granted', payment_status: 'paid', paid_at: ago(2), granted_at: ago(2), duration_days: 14 },
  ]
  const LOCATIONS = [{ id: STILL, settings: { pipelines: { programmes: RULES } } }]
  const fixtures = (over = {}) => ({
    pipelines: THREE, pipeline_stages: STAGES3, contacts: CONTACTS3, deals: DEALS3,
    trial_purchases: PURCHASES, pipeline_board_claims: [], locations: LOCATIONS, ...over,
  })

  it('a real run: the buyer\'s deal moves to the €39 board (stage AND pipeline in one update), the 50+ lead gets a recorded claim and a Programmes deal, the plain lead is unchanged', async () => {
    const { db, calls, writesTo, argOf } = recordingDb(fixtures())
    const out = await reclassifyAllContacts(db, { locationId: STILL, source: 'cron' })

    // The deals read carries pipeline_id (a cross-board move must know the board it leaves).
    const dealsRead = calls.find((e) => e[0] === 'deals' && argOf(e, 'select'))
    expect(argOf(dealsRead, 'select')[1]).toBe('id, contact_id, stage_id, pipeline_id')

    // Claim recorded BEFORE the deal writes.
    const claimWrites = writesTo('pipeline_board_claims')
    expect(claimWrites).toHaveLength(1)
    const upsert = argOf(claimWrites[0], 'upsert')
    expect(upsert[1]).toHaveLength(1)
    expect(upsert[1][0]).toMatchObject({ contact_id: 'c-fifty', location_id: STILL, board_key: 'programmes', source: 'lead_source' })
    expect(upsert[2]).toEqual({ onConflict: 'contact_id,location_id,board_key' })
    const firstDealWrite = calls.findIndex((e) => e[0] === 'deals' && (argOf(e, 'update') || argOf(e, 'insert')))
    expect(calls.indexOf(claimWrites[0])).toBeLessThan(firstDealWrite)

    const updates = writesTo('deals').filter((e) => argOf(e, 'update'))
    expect(updates).toHaveLength(1)
    expect(argOf(updates[0], 'update')[1]).toEqual({ stage_id: 's-paid_trial_new_lead', pipeline_id: 'p-paid' })
    expect(argOf(updates[0], 'in')).toEqual(['in', 'id', ['d-buyer']])

    const inserts = writesTo('deals').filter((e) => argOf(e, 'insert'))
    expect(inserts).toHaveLength(1)
    expect(argOf(inserts[0], 'insert')[1]).toMatchObject({ contact_id: 'c-fifty', stage_id: 's-programme_lead', pipeline_id: 'p-prog', location_id: STILL, status: 'open' })

    expect(out).toMatchObject({
      ok: true, input_source: 'contacts', contacts_seen: 3, deals_moved: 1, deals_created: 1, deals_unchanged: 1, boards_moved: 1, errors: 0,
      movement_matrix: { pack_member: { paid_trial_new_lead: 1 }, '': { programme_lead: 1 } },
    })
    expect(out.pipelines_skipped).toEqual([])
  })

  it('a dry run writes nothing and reports the board histogram and the pending claims', async () => {
    const { db, calls } = recordingDb(fixtures())
    const out = await reclassifyAllContacts(db, { locationId: STILL, dryRun: true })
    expect(calls.filter((e) => e.some((x) => Array.isArray(x) && ['update', 'insert', 'upsert'].includes(x[0])))).toHaveLength(0)
    expect(out).toMatchObject({
      ok: true, deals_moved: 1, deals_created: 1, deals_unchanged: 1, boards_moved: 1, claims_pending: 1,
      board_histogram: { acquisition: 1, paid_trial: 1, programmes: 1 },
      stage_histogram: { new_lead: 1, paid_trial_new_lead: 1, programme_lead: 1 },
    })
  })

  it('a same-board move still writes stage_id alone (today\'s payload), and a stored claim is not re-written', async () => {
    const { db, writesTo, argOf } = recordingDb(fixtures({
      deals: [{ id: 'd-fifty', contact_id: 'c-fifty', stage_id: 's-programme_first_class', pipeline_id: 'p-prog', location_id: STILL, status: 'open' }],
      contacts: [CONTACTS3[1]],
      pipeline_board_claims: [{ contact_id: 'c-fifty', location_id: STILL, board_key: 'programmes', claimed_at: ago(1), source: 'lead_source' }],
      trial_purchases: [],
    }))
    const out = await reclassifyAllContacts(db, { locationId: STILL })
    expect(writesTo('pipeline_board_claims')).toHaveLength(0)
    const updates = writesTo('deals').filter((e) => argOf(e, 'update'))
    expect(updates).toHaveLength(1)
    expect(argOf(updates[0], 'update')[1]).toEqual({ stage_id: 's-programme_lead' })
    expect(out).toMatchObject({ deals_moved: 1, boards_moved: 0 })
  })

  it('an unreadable trial_purchases read fails the run: audit row failed, no deal written, nobody moved back', async () => {
    const { db, writesTo, argOf } = recordingDb(fixtures(), { errors: { trial_purchases: 'tp down' } })
    const out = await reclassifyAllContacts(db, { locationId: STILL })
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/claims unavailable: purchases_unreadable/)
    expect(writesTo('deals')).toHaveLength(0)
    expect(writesTo('pipeline_board_claims')).toHaveLength(0)
    const close = writesTo('pipeline_classification_runs').find((e) => argOf(e, 'update'))
    expect(argOf(close, 'update')[1]).toMatchObject({ status: 'failed', error_message: 'claims unavailable: purchases_unreadable' })
  })

  it('an unreadable settings read fails the run the same way', async () => {
    const { db, writesTo } = recordingDb(fixtures(), { errors: { locations: 'settings down' } })
    const out = await reclassifyAllContacts(db, { locationId: STILL })
    expect(out).toMatchObject({ ok: false, error: 'claims unavailable: settings_unreadable' })
    expect(writesTo('deals')).toHaveLength(0)
  })

  it('a location with the acquisition board alone never reads trial_purchases, claims or settings', async () => {
    const { db, tables } = recordingDb(fixtures({ pipelines: [THREE[0]], deals: DEALS3 }))
    await reclassifyAllContacts(db, { locationId: STILL })
    expect(tables()).not.toContain('trial_purchases')
    expect(tables()).not.toContain('pipeline_board_claims')
    expect(tables()).not.toContain('locations')
  })

  it('includeDisabled dry-runs a disabled claim board as its OWN module (paid_trial), not acquisition_un1t', async () => {
    const disabled = THREE.map((p) => (p.key === 'paid_trial' ? { ...p, enabled: false } : p))
    const { db, calls, argOf } = recordingDb(fixtures({ pipelines: disabled }))
    const out = await reclassifyAllContacts(db, { locationId: STILL, dryRun: true, includeDisabled: ['paid_trial'] })
    const pipelineCalls = calls.filter((e) => e[0] === 'pipelines')
    expect(pipelineCalls).toHaveLength(2)
    expect(argOf(pipelineCalls[1], 'in')).toEqual(['in', 'key', ['paid_trial']])
    expect(membershipReadsFor).not.toHaveBeenCalled()
    expect(out).toMatchObject({ ok: true, input_source: 'contacts', board_histogram: { acquisition: 1, paid_trial: 1, programmes: 1 } })
  })
})


// PIPE3 fix pass (review #1, #4) — a contact holding two open deals at the
// studio: the deal on the target board is the one moved, the surplus is closed
// 'lost' and counted, so a person is never on two boards.
describe('PIPE3 — a contact with two open deals', () => {
  const STILL = 'loc-st'
  const NOW = Date.now()
  const ago = (d) => new Date(NOW - d * 86_400_000).toISOString()
  const THREE = [
    { id: 'p-acq', location_id: STILL, key: 'acquisition', module: 'acquisition', mode: 'derived', enabled: true, is_primary: true },
    { id: 'p-paid', location_id: STILL, key: 'paid_trial', module: 'paid_trial', mode: 'derived', enabled: true, is_primary: false },
    { id: 'p-prog', location_id: STILL, key: 'programmes', module: 'programmes', mode: 'derived', enabled: true, is_primary: false },
  ]
  const STAGES3 = [
    ...['new_lead', 'pack_member', 'dormant'].map((slug) => ({ id: `s-${slug}`, slug, pipeline_id: 'p-acq', location_id: STILL })),
    ...['paid_trial_new_lead', 'paid_trial_day_7'].map((slug) => ({ id: `s-${slug}`, slug, pipeline_id: 'p-paid', location_id: STILL })),
    ...['programme_lead'].map((slug) => ({ id: `s-${slug}`, slug, pipeline_id: 'p-prog', location_id: STILL })),
  ]
  it('keeps the target-board deal, moves it stage-only, closes the surplus lost, and counts it', async () => {
    const { db, writesTo, argOf } = recordingDb({
      pipelines: THREE, pipeline_stages: STAGES3,
      contacts: [{ id: 'c-buyer', name: 'Buyer', email: null, glofox_membership_status: 'trial', trial_credits_remaining: 10, joined_at: ago(2), created_at: ago(2), recent_bookings: [] }],
      deals: [
        { id: 'd-acq', contact_id: 'c-buyer', stage_id: 's-pack_member', pipeline_id: 'p-acq', location_id: STILL, status: 'open' },
        { id: 'd-paid', contact_id: 'c-buyer', stage_id: 's-paid_trial_day_7', pipeline_id: 'p-paid', location_id: STILL, status: 'open' },
      ],
      trial_purchases: [{ id: 'tp-1', location_id: STILL, contact_id: 'c-buyer', status: 'granted', payment_status: 'paid', paid_at: ago(2), granted_at: ago(2), duration_days: 14 }],
      pipeline_board_claims: [], locations: [{ id: STILL, settings: {} }],
    })
    const out = await reclassifyAllContacts(db, { locationId: STILL })
    const updates = writesTo('deals').filter((e) => argOf(e, 'update'))
    const move = updates.find((e) => argOf(e, 'update')[1].stage_id)
    expect(argOf(move, 'update')[1]).toEqual({ stage_id: 's-paid_trial_new_lead' })
    expect(argOf(move, 'in')).toEqual(['in', 'id', ['d-paid']])
    const close = updates.find((e) => argOf(e, 'update')[1].status === 'lost')
    expect(argOf(close, 'in')).toEqual(['in', 'id', ['d-acq']])
    expect(out).toMatchObject({ deals_moved: 1, boards_moved: 0, duplicate_deals_closed: 1 })
  })
})
