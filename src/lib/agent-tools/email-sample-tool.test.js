import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/email-audience-counts', () => ({ emailAudienceCounts: vi.fn() }))
vi.mock('@/lib/email-audience-sample', () => ({ emailAudienceSample: vi.fn() }))

import { runTool } from './registry.js'
import { TOOLS } from './index.js'
import sampleEmailAudience from './sample-email-audience.js'
import { emailAudienceCounts } from '@/lib/email-audience-counts'
import { emailAudienceSample } from '@/lib/email-audience-sample'

const DUB = '0b6d5d8e-6f0c-4a49-9a8e-2b8f0c6d1a01'
const NOEMAIL = '0b6d5d8e-6f0c-4a49-9a8e-2b8f0c6d1a02'
const ME = '0b6d5d8e-6f0c-4a49-9a8e-2b8f0c6d1b01'
const CAMP = '0b6d5d8e-6f0c-4a49-9a8e-2b8f0c6d1c01'
const SEG = '0b6d5d8e-6f0c-4a49-9a8e-2b8f0c6d1d01'
const FILTER = { logic: 'and', filters: [{ field: 'name', op: 'contains', value: 'a' }] }
const SAMPLE = [{ first_name: 'Pat', email: 'pa•••@example.com', stage: 'lead' }]

function auth() {
  const loc = (id, name) => ({ id, name, timezone: 'Europe/Dublin', organization_id: 'org-1' })
  const locations = [loc(DUB, 'Dublin Studio'), loc(NOEMAIL, 'No Email')]
  const mk = (perms) => ({ role: 'manager', permissions: { mcp_access: true, ...perms } })
  return {
    token: 't', clientId: 'client-1', scopes: [],
    extra: {
      user: {
        id: ME, full_name: 'Pat', role: 'manager', isMaster: false, locations, activeLocation: locations[0],
        rolesByLocation: { [DUB]: 'manager', [NOEMAIL]: 'manager' },
        assignmentsByLocation: { [DUB]: mk({ email: true }), [NOEMAIL]: mk({ email: false }) },
      },
      enabledOrgIds: ['org-1'],
      mcpAccessAnywhere: true,
    },
  }
}

function makeDb(tables = {}) {
  const queries = []
  const db = {
    from: vi.fn((table) => {
      const q = { table, calls: [] }
      queries.push(q)
      const answer = () => tables[table] ?? { data: [], error: null }
      const b = {}
      for (const m of ['select', 'eq', 'in', 'order', 'limit']) b[m] = (...a) => { q.calls.push([m, ...a]); return b }
      b.maybeSingle = async () => answer()
      b.then = (res, rej) => Promise.resolve(answer()).then(res, rej)
      return b
    }),
  }
  return { db, on: (t) => queries.filter((q) => q.table === t) }
}

const run = (input, db) => runTool(sampleEmailAudience, input, auth(), { db })

describe('sample_email_audience', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    emailAudienceSample.mockResolvedValue(SAMPLE)
    emailAudienceCounts.mockResolvedValue({ matched: 10, eligible: 8, excluded: {} })
  })

  it('is registered, read-only, and gated on the email permission', async () => {
    expect(TOOLS).toContain(sampleEmailAudience)
    expect(sampleEmailAudience.writes).toBeFalsy()
    const { db } = makeDb()
    expect(await run({ filter: FILTER, studio_id: NOEMAIL }, db)).toMatchObject({ ok: false, code: 'forbidden' })
  })

  it('samples an inline filter and reports the eligible count', async () => {
    const { db } = makeDb()
    const r = await run({ filter: FILTER }, db)
    expect(r).toMatchObject({ ok: true, data: { sample: SAMPLE, count: 8 } })
    expect(r.data.note).toMatch(/up to 50/)
    expect(emailAudienceSample).toHaveBeenCalledWith(db, { filter: FILTER, locationId: DUB })
    expect(emailAudienceCounts).toHaveBeenCalledWith(db, { filter: FILTER, locationId: DUB })
  })

  it('samples a saved segment read at this studio', async () => {
    const { db, on } = makeDb({ contact_segments: { data: { id: SEG, filter: FILTER }, error: null } })
    const r = await run({ segment_id: SEG }, db)
    expect(r.ok).toBe(true)
    expect(on('contact_segments')[0].calls).toContainEqual(['eq', 'location_id', DUB])
  })

  it("samples a campaign's stored filter, read at this studio", async () => {
    const { db, on } = makeDb({ campaigns: { data: { id: CAMP, audience_filter: FILTER }, error: null } })
    const r = await run({ campaign_id: CAMP }, db)
    expect(r.ok).toBe(true)
    expect(on('campaigns')[0].calls).toContainEqual(['eq', 'location_id', DUB])
    expect(emailAudienceSample).toHaveBeenCalledWith(db, { filter: FILTER, locationId: DUB })
  })

  it('needs exactly one of segment_id, filter and campaign_id', async () => {
    const { db } = makeDb()
    expect(await run({}, db)).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(await run({ filter: FILTER, campaign_id: CAMP }, db)).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(await run({ segment_id: SEG, campaign_id: CAMP }, db)).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(emailAudienceSample).not.toHaveBeenCalled()
  })

  it('refuses an empty filter and a campaign with no audience', async () => {
    const { db } = makeDb({ campaigns: { data: { id: CAMP, audience_filter: { logic: 'and', filters: [] } }, error: null } })
    expect(await run({ filter: { logic: 'and', filters: [] } }, db)).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(await run({ campaign_id: CAMP }, db)).toMatchObject({ ok: false, code: 'invalid_input' })
    const none = makeDb({ campaigns: { data: { id: CAMP, audience_filter: null }, error: null } })
    expect(await run({ campaign_id: CAMP }, none.db)).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(emailAudienceSample).not.toHaveBeenCalled()
  })

  it("answers not_found for another studio's campaign", async () => {
    const { db } = makeDb({ campaigns: { data: null, error: null } })
    expect(await run({ campaign_id: CAMP }, db)).toMatchObject({ ok: false, code: 'not_found' })
  })
})
