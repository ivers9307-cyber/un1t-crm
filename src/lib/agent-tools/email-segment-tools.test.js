import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/email-audience-counts', () => ({ emailAudienceCounts: vi.fn() }))

import { runTool } from './registry.js'
import createEmailSegment from './create-email-segment.js'
import updateEmailSegment from './update-email-segment.js'
import { emailAudienceCounts } from '@/lib/email-audience-counts'

const DUB = '0b6d5d8e-6f0c-4a49-9a8e-2b8f0c6d1a01'
const NOCONTACTS = '0b6d5d8e-6f0c-4a49-9a8e-2b8f0c6d1a02'
const ME = '0b6d5d8e-6f0c-4a49-9a8e-2b8f0c6d1b01'
const SEG = '0b6d5d8e-6f0c-4a49-9a8e-2b8f0c6d1d01'
const NOW_MS = Date.UTC(2031, 6, 15, 12, 0, 0)
const FILTER = { logic: 'and', filters: [{ field: 'name', op: 'contains', value: 'a' }] }
const COUNTS = { matched: 10, eligible: 8, excluded: { not_opted_in: 1, bounced_or_complained: 1, suppressed: 0 } }

function auth() {
  const loc = (id, name) => ({ id, name, timezone: 'Europe/Dublin', organization_id: 'org-1' })
  const locations = [loc(DUB, 'Dublin Studio'), loc(NOCONTACTS, 'No Contacts')]
  const mk = (perms) => ({ role: 'manager', permissions: { mcp_access: true, ...perms } })
  return {
    token: 't', clientId: 'client-1', scopes: [],
    extra: {
      user: {
        id: ME, full_name: 'Pat', role: 'manager', isMaster: false, locations, activeLocation: locations[0],
        rolesByLocation: { [DUB]: 'manager', [NOCONTACTS]: 'manager' },
        assignmentsByLocation: {
          [DUB]: mk({ email: true, contacts: true }),
          [NOCONTACTS]: mk({ email: true, contacts: false }),
        },
      },
      enabledOrgIds: ['org-1'],
      mcpAccessAnywhere: true,
    },
  }
}

// answers: { segment: row|null, insert, update, sequences: {count,error} }
function makeDb(answers = {}) {
  const ops = []
  const db = {
    rpc: vi.fn(async () => ({ data: [], error: null })),
    from: vi.fn((table) => {
      const q = { table, calls: [], kind: 'select', payload: null }
      ops.push(q)
      const answer = () => {
        if (table === 'email_sequences') return answers.sequences ?? { count: 0, error: null }
        if (q.kind === 'insert') return answers.insert ?? { data: [{ id: SEG, name: q.payload?.name }], error: null }
        if (q.kind === 'update') return answers.update ?? { data: [{ id: SEG, name: q.payload?.name ?? 'Lapsed' }], error: null }
        return { data: answers.segment === undefined ? null : answers.segment, error: null }
      }
      const b = {}
      for (const m of ['select', 'eq', 'in', 'order', 'limit']) {
        b[m] = (...args) => { q.calls.push([m, ...args]); return b }
      }
      b.insert = (p) => { q.kind = 'insert'; q.payload = p; return b }
      b.update = (p) => { q.kind = 'update'; q.payload = p; return b }
      b.maybeSingle = async () => answer()
      b.single = async () => { const a = answer(); return { data: Array.isArray(a.data) ? a.data[0] : a.data, error: a.error } }
      b.then = (res, rej) => Promise.resolve(answer()).then(res, rej)
      return b
    }),
  }
  return { db, ops, writes: (k) => ops.filter((o) => o.kind === k && o.table === 'contact_segments') }
}
const run = (tool, input, db) => runTool(tool, input, auth(), { db, nowMs: NOW_MS })
const existing = { id: SEG, location_id: DUB, name: 'Lapsed' }

beforeEach(() => {
  vi.clearAllMocks()
  emailAudienceCounts.mockResolvedValue(COUNTS)
})

describe('create_email_segment', () => {
  it('creates a segment at the studio stamped with the person', async () => {
    const { db, writes } = makeDb()
    const r = await run(createEmailSegment, { name: '  Lapsed  ', description: 'Gone quiet', filter: FILTER }, db)
    expect(r.ok).toBe(true)
    expect(writes('insert')[0].payload).toEqual({
      location_id: DUB, name: 'Lapsed', description: 'Gone quiet', filter: FILTER, created_by: ME,
    })
    expect(r.data).toEqual({ segment: { id: SEG, name: 'Lapsed' }, count: 8 })
    expect(emailAudienceCounts).toHaveBeenCalledWith(db, { filter: FILTER, locationId: DUB })
  })

  it('refuses a duplicate name as a conflict', async () => {
    const { db } = makeDb({ insert: { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } } })
    const r = await run(createEmailSegment, { name: 'Lapsed', filter: FILTER }, db)
    expect(r).toMatchObject({ ok: false, code: 'conflict', message: 'A segment with this name already exists.' })
  })

  it('refuses a filter with no rows, or an invalid one, without writing', async () => {
    const empty = makeDb()
    expect(await run(createEmailSegment, { name: 'X', filter: { logic: 'and', filters: [] } }, empty.db))
      .toMatchObject({ ok: false, code: 'invalid_input', message: 'The audience filter needs at least one filter row.' })
    const bad = makeDb()
    expect(await run(createEmailSegment, { name: 'X', filter: { logic: 'and', filters: [{ field: 'nope', op: 'is', value: 1 }] } }, bad.db))
      .toMatchObject({ ok: false, code: 'invalid_input' })
    expect(empty.writes('insert')).toHaveLength(0)
    expect(bad.writes('insert')).toHaveLength(0)
  })

  it('needs both the email and segment-write permissions', async () => {
    const { db, writes } = makeDb()
    const r = await run(createEmailSegment, { studio_id: NOCONTACTS, name: 'X', filter: FILTER }, db)
    expect(r.ok).toBe(false)
    expect(writes('insert')).toHaveLength(0)
    expect(createEmailSegment.writes).toBe(true)
  })
})

describe('update_email_segment', () => {
  it('edits a segment no sequence starts from, scoped to the studio', async () => {
    const { db, ops, writes } = makeDb({ segment: existing })
    const r = await run(updateEmailSegment, { segment_id: SEG, name: ' Renamed ', filter: FILTER }, db)
    expect(r.ok).toBe(true)
    const load = ops.find((o) => o.kind === 'select' && o.table === 'contact_segments')
    expect(load.calls).toContainEqual(['eq', 'id', SEG])
    expect(load.calls).toContainEqual(['eq', 'location_id', DUB])
    const upd = writes('update')[0]
    expect(upd.payload).toMatchObject({ name: 'Renamed', filter: FILTER })
    expect(upd.payload.updated_at).toEqual(expect.any(String))
    expect(upd.calls).toContainEqual(['eq', 'location_id', DUB])
    expect(r.data).toEqual({ segment: { id: SEG, name: 'Renamed' }, count: 8 })
  })

  it('refuses an edit to a segment any sequence starts from, a draft sequence included', async () => {
    const { db, ops, writes } = makeDb({ segment: existing, sequences: { count: 1, error: null } })
    const r = await run(updateEmailSegment, { segment_id: SEG, name: 'Renamed' }, db)
    expect(r).toMatchObject({ ok: false, code: 'conflict', message: 'A sequence starts from this segment. Edit it in the CRM.' })
    expect(writes('update')).toHaveLength(0)
    const seq = ops.find((o) => o.table === 'email_sequences')
    expect(seq.calls).not.toContainEqual(['eq', 'status', 'active'])
  })

  it('fails, and does not edit, when the sequence count cannot be read', async () => {
    const { db, writes } = makeDb({ segment: existing, sequences: { count: null, error: { message: 'db down' } } })
    const r = await run(updateEmailSegment, { segment_id: SEG, name: 'Renamed' }, db)
    expect(r).toMatchObject({ ok: false, code: 'tool_failed' })
    expect(writes('update')).toHaveLength(0)
  })

  it('answers not_found for another studio\'s segment', async () => {
    const { db, writes } = makeDb({ segment: null })
    const r = await run(updateEmailSegment, { segment_id: SEG, name: 'X' }, db)
    expect(r).toMatchObject({ ok: false, code: 'not_found' })
    expect(writes('update')).toHaveLength(0)
  })

  it('needs at least one change, and a valid filter', async () => {
    const a = makeDb({ segment: existing })
    expect(await run(updateEmailSegment, { segment_id: SEG }, a.db)).toMatchObject({ ok: false })
    const b = makeDb({ segment: existing })
    expect(await run(updateEmailSegment, { segment_id: SEG, filter: { logic: 'and', filters: [] } }, b.db))
      .toMatchObject({ ok: false, code: 'invalid_input' })
    expect(a.writes('update')).toHaveLength(0)
    expect(b.writes('update')).toHaveLength(0)
  })

  it('refuses a duplicate name as a conflict', async () => {
    const { db } = makeDb({ segment: existing, update: { data: null, error: { code: '23505', message: 'duplicate key' } } })
    expect(await run(updateEmailSegment, { segment_id: SEG, name: 'Taken' }, db))
      .toMatchObject({ ok: false, code: 'conflict', message: 'A segment with this name already exists.' })
  })

  it('needs both the email and segment-write permissions', async () => {
    const { db } = makeDb({ segment: existing })
    expect((await run(updateEmailSegment, { studio_id: NOCONTACTS, segment_id: SEG, name: 'X' }, db)).ok).toBe(false)
    expect(updateEmailSegment.writes).toBe(true)
  })
})
