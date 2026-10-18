// HATCHPIPE.5 — POST /api/admin/pipeline-reclassify { restamp_dates: true }.
//
// The one-off backfill of the real dates onto the deals Hatch Street's first
// classification run created (every one dated 18 Oct 2026). End to end through
// the real orchestrator: only the auth, the db and the un1t.online read seam
// are fakes.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/membership/reads/index.js', () => ({
  membershipReadsFor: vi.fn(),
  supportsRead: (r, key) => typeof r?.reads?.[key] === 'function',
}))
vi.mock('@/lib/log.js', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { membershipReadsFor } = await import('@/lib/membership/reads/index.js')
const { logWarn } = await import('@/lib/log.js')
const { POST } = await import('./route.js')

const HATCH = '28c78d6b-f7b3-4edf-8c7c-840bd047b3f4'
const STILL = 'a0000000-0000-0000-0000-000000000001'
const RUN = '2026-10-18T11:45:26.000000+00:00' // the first classification run
const DAY = 86_400_000
const ago = (d) => new Date(Date.now() - d * DAY).toISOString()

const PIPELINES = [
  { id: 'p-acq', location_id: HATCH, key: 'acquisition', module: 'acquisition_un1t', mode: 'derived', enabled: true, is_primary: false },
  { id: 'p-wait', location_id: HATCH, key: 'waitlist', module: null, mode: 'manual', enabled: true, is_primary: true },
  { id: 'p-st', location_id: STILL, key: 'acquisition', module: 'acquisition', mode: 'derived', enabled: true, is_primary: true },
]
const STAGES = [
  { id: 's-new', slug: 'new_lead', pipeline_id: 'p-acq', location_id: HATCH },
  { id: 's-first', slug: 'first_class', pipeline_id: 'p-acq', location_id: HATCH },
  { id: 's-second', slug: 'second_class', pipeline_id: 'p-acq', location_id: HATCH },
  { id: 's-wait', slug: 'waitlist_new_enquiry', pipeline_id: 'p-wait', location_id: HATCH },
  { id: 's-st-new', slug: 'new_lead', pipeline_id: 'p-st', location_id: STILL },
]
const deal = (id, contactId, stageId, over = {}) => ({
  id, contact_id: contactId, stage_id: stageId, pipeline_id: 'p-acq', location_id: HATCH, status: 'open',
  created_at: RUN, stage_entered_at: RUN, ...over,
})
const evidence = (over = {}) => ({
  client_created_at: ago(30), attended_starts: [], last_attended_at: null, joined_at: ago(30),
  membership_status: 'lead', ...over,
})

/**
 * A fake that records every call and applies eq/in filters to SELECTs and
 * UPDATEs alike (a filter on a column the row lacks excludes nothing).
 * `failUpdate(id)` makes the update of that deal id answer an error.
 */
function fakeDb(tables, { failUpdate = () => false } = {}) {
  const calls = []
  const writes = []
  function chain(table) {
    const entry = { table, ops: [] }
    calls.push(entry)
    let op = 'select'
    let payload = null
    const filters = []
    const c = {}
    for (const m of ['select', 'eq', 'in', 'order', 'range', 'single', 'maybeSingle', 'limit', 'update', 'insert']) {
      c[m] = (...args) => {
        entry.ops.push([m, ...args])
        if (m === 'update' || m === 'insert') { op = m; payload = args[0] }
        if (m === 'eq') filters.push((r) => !(args[0] in r) || r[args[0]] === args[1])
        if (m === 'in') filters.push((r) => !(args[0] in r) || args[1].includes(r[args[0]]))
        return c
      }
    }
    const rows = () => (tables[table] || []).filter((r) => filters.every((f) => f(r)))
    c.then = (resolve) => {
      if (op === 'insert') {
        writes.push({ table, op, payload })
        return resolve({ data: { id: 'run-1' }, error: null })
      }
      if (op === 'update') {
        const hit = rows()
        if (table === 'deals' && hit.some((r) => failUpdate(r.id))) return resolve({ data: null, error: { message: 'deadlock detected' } })
        if (hit.length) writes.push({ table, op, payload, ids: hit.map((r) => r.id) })
        for (const r of hit) Object.assign(r, payload)
        return resolve({ data: hit.map((r) => ({ id: r.id })), error: null })
      }
      // copies, as a real read returns: a later change to the table does not reach them
      return resolve({ data: rows().map((r) => ({ ...r })), error: null })
    }
    return c
  }
  return { db: { from: (t) => chain(t) }, calls, writes }
}

function seam(evidenceByContact) {
  const pipelineInputs = vi.fn().mockResolvedValue({
    success: true,
    data: {
      contacts: [...evidenceByContact.keys()].map((id) => ({ id, name: 'n', email: null, location_id: HATCH })),
      snapshots: new Map([...evidenceByContact.keys()].map((id) => [id, { glofox_membership_status: 'lead', recent_bookings: [] }])),
      evidence: evidenceByContact,
      unlinked: 0,
      skipped_no_contact: 0,
    },
  })
  vi.mocked(membershipReadsFor).mockResolvedValue({
    source: 'un1t_online', state: 'configured', reads: { pipelineInputs }, error: null, capabilities: {},
  })
  return pipelineInputs
}

const req = (body) => new Request('http://test/api/admin/pipeline-reclassify', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})

// The world: three Hatch acquisition deals (one restampable, one already right,
// one with no evidence), a Hatch waitlist deal and a Stillorgan deal that must
// never be touched.
function world() {
  const five = ago(5)
  const deals = [
    deal('d-first', 'c-first', 's-first'),
    deal('d-same', 'c-same', 's-new', { created_at: five, stage_entered_at: five }),
    deal('d-none', 'c-none', 's-second'),
    deal('d-wait', 'c-first', 's-wait', { pipeline_id: 'p-wait' }),
    deal('d-st', 'c-first', 's-st-new', { pipeline_id: 'p-st', location_id: STILL }),
  ]
  const ev = new Map([
    ['c-first', evidence({ attended_starts: [ago(12)], last_attended_at: ago(12) })],
    ['c-same', evidence({ client_created_at: five, joined_at: five })],
    ['c-none', evidence({ client_created_at: null, attended_starts: [ago(3)] })],
  ])
  return { deals, ev }
}

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue({ id: 'master-1', profileRole: 'master' })
})

describe('restamp_dates — access', () => {
  it('is master only: an owner gets 403 and nothing is read', async () => {
    getCurrentUser.mockResolvedValue({ id: 'owner-1', profileRole: 'owner' })
    const { db, calls } = fakeDb({})
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ location_id: HATCH, restamp_dates: true, dry_run: true }))
    expect(res.status).toBe(403)
    expect(calls).toHaveLength(0)
    expect(membershipReadsFor).not.toHaveBeenCalled()
  })

  it('signed out gets 401', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await POST(req({ location_id: HATCH, restamp_dates: true }))
    expect(res.status).toBe(401)
  })

  it('needs an explicit location_id (never the active location)', async () => {
    getCurrentUser.mockResolvedValue({ id: 'master-1', profileRole: 'master', activeLocation: { id: HATCH } })
    const { db, calls } = fakeDb({})
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ restamp_dates: true, dry_run: true }))
    expect(res.status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it('refuses include_disabled alongside restamp_dates', async () => {
    const res = await POST(req({ location_id: HATCH, restamp_dates: true, dry_run: true, include_disabled: ['acquisition'] }))
    expect(res.status).toBe(400)
  })
})

describe('restamp_dates — dry run', () => {
  it('writes nothing and reports counts plus a sample of ids and dates only', async () => {
    const { deals, ev } = world()
    seam(ev)
    const { db, writes } = fakeDb({ pipelines: PIPELINES, pipeline_stages: STAGES, deals })
    createServerClient.mockReturnValue(db)

    const res = await POST(req({ location_id: HATCH, restamp_dates: true, dry_run: true }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(writes).toHaveLength(0)
    expect(body).toMatchObject({ ok: true, dry_run: true, deals_seen: 3, updated: 1, unchanged: 1, no_evidence: 1, errors: 0 })
    expect(body.sample).toHaveLength(1)
    const [s] = body.sample
    expect(Object.keys(s).sort()).toEqual(['created_at', 'deal_id', 'stage_entered_at', 'stage_slug'])
    expect(s.deal_id).toBe('d-first')
    expect(s.stage_slug).toBe('first_class')
    expect(s.created_at.from).toBe(RUN)
    expect(Math.abs(Date.parse(s.created_at.to) - (Date.now() - 30 * DAY))).toBeLessThan(5_000)
    expect(Math.abs(Date.parse(s.stage_entered_at.to) - (Date.now() - 12 * DAY))).toBeLessThan(5_000)
    expect(JSON.stringify(body)).not.toMatch(/"name"|"email"|"title"|contact_id/)
  })
})

describe('restamp_dates — real run', () => {
  it('updates only the two date columns, only on the un1t board at that location, guarded on stage and status', async () => {
    const { deals, ev } = world()
    seam(ev)
    const { db, writes, calls } = fakeDb({ pipelines: PIPELINES, pipeline_stages: STAGES, deals })
    createServerClient.mockReturnValue(db)

    const res = await POST(req({ location_id: HATCH, restamp_dates: true }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({ ok: true, dry_run: false, deals_seen: 3, updated: 1, unchanged: 1, no_evidence: 1, errors: 0 })
    expect(writes).toHaveLength(1)
    const [w] = writes
    expect(w.table).toBe('deals')
    expect(w.ids).toEqual(['d-first'])
    expect(Object.keys(w.payload).sort()).toEqual(['created_at', 'stage_entered_at'])
    // no stage change, no contacts write, no audit row
    expect(writes.some((x) => x.table === 'contacts' || x.table === 'pipeline_classification_runs')).toBe(false)
    const upd = calls.find((e) => e.table === 'deals' && e.ops.some((o) => o[0] === 'update'))
    expect(upd.ops.filter((o) => o[0] === 'eq')).toEqual([
      ['eq', 'id', 'd-first'], ['eq', 'location_id', HATCH], ['eq', 'pipeline_id', 'p-acq'],
      ['eq', 'stage_id', 's-first'], ['eq', 'status', 'open'],
    ])
    // the deal read was scoped to the location, open deals and the un1t board
    const read = calls.find((e) => e.table === 'deals' && e.ops.some((o) => o[0] === 'select'))
    expect(read.ops).toEqual(expect.arrayContaining([
      ['eq', 'location_id', HATCH], ['eq', 'status', 'open'], ['in', 'pipeline_id', ['p-acq']],
    ]))
    // the waitlist and Stillorgan deals still carry the run date
    expect(deals.find((d) => d.id === 'd-wait').created_at).toBe(RUN)
    expect(deals.find((d) => d.id === 'd-st').created_at).toBe(RUN)
    expect(deals.find((d) => d.id === 'd-first').stage_id).toBe('s-first')
  })

  it('a second run changes nothing (idempotent)', async () => {
    const { deals, ev } = world()
    seam(ev)
    const fake = fakeDb({ pipelines: PIPELINES, pipeline_stages: STAGES, deals })
    createServerClient.mockReturnValue(fake.db)
    await POST(req({ location_id: HATCH, restamp_dates: true }))
    fake.writes.length = 0
    const body = await (await POST(req({ location_id: HATCH, restamp_dates: true }))).json()
    expect(fake.writes).toHaveLength(0)
    expect(body).toMatchObject({ updated: 0, unchanged: 2, no_evidence: 1 })
  })

  it('a failed update is logged with ids, counted, and the run carries on', async () => {
    const { deals, ev } = world()
    deals.push(deal('d-second', 'c-two', 's-first'))
    ev.set('c-two', evidence({ attended_starts: [ago(8)] }))
    seam(ev)
    const { db, writes } = fakeDb({ pipelines: PIPELINES, pipeline_stages: STAGES, deals }, { failUpdate: (id) => id === 'd-first' })
    createServerClient.mockReturnValue(db)

    const body = await (await POST(req({ location_id: HATCH, restamp_dates: true }))).json()

    expect(body).toMatchObject({ ok: true, updated: 1, errors: 1 })
    expect(writes.map((x) => x.ids)).toEqual([['d-second']])
    expect(logWarn).toHaveBeenCalledWith('pipeline-reclassify', 'restamp update failed', {
      deal_id: 'd-first', locationId: HATCH, err: 'deadlock detected',
    })
  })

  it('a deal that moved or closed since the read is skipped, not stamped', async () => {
    const { deals, ev } = world()
    seam(ev)
    const fake = fakeDb({ pipelines: PIPELINES, pipeline_stages: STAGES, deals })
    // the reclassifier moves d-first between the read and the write
    const realFrom = fake.db.from
    let dealReads = 0
    fake.db.from = (t) => {
      const c = realFrom(t)
      if (t === 'deals') {
        const then = c.then
        c.then = (resolve) => then((r) => {
          if (dealReads++ === 0) deals.find((d) => d.id === 'd-first').stage_id = 's-second'
          return resolve(r)
        })
      }
      return c
    }
    createServerClient.mockReturnValue(fake.db)

    const body = await (await POST(req({ location_id: HATCH, restamp_dates: true }))).json()

    expect(body).toMatchObject({ ok: true, updated: 0, skipped_changed: 1, errors: 0 })
    expect(fake.writes).toHaveLength(0)
  })
})

describe('restamp_dates — boards and inputs', () => {
  it('a location with no un1t.online board does nothing and never asks the seam', async () => {
    const { db, writes } = fakeDb({ pipelines: PIPELINES, pipeline_stages: STAGES, deals: world().deals })
    createServerClient.mockReturnValue(db)
    const body = await (await POST(req({ location_id: STILL, restamp_dates: true }))).json()
    expect(body).toMatchObject({ ok: true, deals_seen: 0, updated: 0, un1t_boards: [] })
    expect(membershipReadsFor).not.toHaveBeenCalled()
    expect(writes).toHaveLength(0)
  })

  it('inputs unavailable → 500 with the reason, logged with the location id, nothing written', async () => {
    vi.mocked(membershipReadsFor).mockResolvedValue({ source: 'un1t_online', state: 'unconfigured', reads: null })
    const { db, writes } = fakeDb({ pipelines: PIPELINES, pipeline_stages: STAGES, deals: world().deals })
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ location_id: HATCH, restamp_dates: true }))
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ ok: false, error: 'un1t inputs unavailable: unconfigured' })
    expect(writes).toHaveLength(0)
    expect(logWarn).toHaveBeenCalledWith('pipeline-reclassify', 'restamp inputs unavailable', expect.objectContaining({ locationId: HATCH, reason: 'unconfigured' }))
  })
})
