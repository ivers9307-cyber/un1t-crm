import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'

vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/email-audience-counts', () => ({ emailAudienceCounts: vi.fn() }))
vi.mock('@/lib/campaign-approval', () => ({ pendingApproval: vi.fn() }))
vi.mock('@/lib/landing-media-library', () => ({ listLandingMediaForUser: vi.fn() }))
vi.mock('@/lib/from-address', () => ({ describeFromAddress: vi.fn() }))
vi.mock('@/lib/campaign-display-stats', async (importActual) => ({
  ...(await importActual()),
  loadCampaignRecipientStats: vi.fn(),
}))

import { runTool } from './registry.js'
import { TOOLS } from './index.js'
import listEmailSegments from './list-email-segments.js'
import countEmailAudience from './count-email-audience.js'
import listEmailImages from './list-email-images.js'
import listEmailCampaigns from './list-email-campaigns.js'
import getEmailCampaign from './get-email-campaign.js'
import { htmlSha256 } from './_email-campaign.js'
import { AUDIENCE_FIELDS } from '@/lib/audience-filter'
import { emailAudienceCounts } from '@/lib/email-audience-counts'
import { pendingApproval } from '@/lib/campaign-approval'
import { listLandingMediaForUser } from '@/lib/landing-media-library'
import { describeFromAddress } from '@/lib/from-address'
import { loadCampaignRecipientStats } from '@/lib/campaign-display-stats'

const DUB = '0b6d5d8e-6f0c-4a49-9a8e-2b8f0c6d1a01'
const NOEMAIL = '0b6d5d8e-6f0c-4a49-9a8e-2b8f0c6d1a02'
const OTHER = '0b6d5d8e-6f0c-4a49-9a8e-2b8f0c6d1a03'
const ME = '0b6d5d8e-6f0c-4a49-9a8e-2b8f0c6d1b01'
const CAMP = '0b6d5d8e-6f0c-4a49-9a8e-2b8f0c6d1c01'
const SEG = '0b6d5d8e-6f0c-4a49-9a8e-2b8f0c6d1d01'
const NOW_MS = Date.UTC(2031, 6, 15, 12, 0, 0)
const FILTER = { logic: 'and', filters: [{ field: 'name', op: 'contains', value: 'a' }] }
const COUNTS = { matched: 10, eligible: 8, excluded: { not_opted_in: 1, bounced_or_complained: 1, suppressed: 0 } }

function auth() {
  const loc = (id, name) => ({ id, name, timezone: 'Europe/Dublin', organization_id: 'org-1' })
  const locations = [loc(DUB, 'Dublin Studio'), loc(NOEMAIL, 'No Email'), loc(OTHER, 'Other')]
  const mk = (perms) => ({ role: 'manager', permissions: { mcp_access: true, ...perms } })
  return {
    token: 't',
    clientId: 'client-1',
    scopes: [],
    extra: {
      user: {
        id: ME, full_name: 'Pat', role: 'manager', isMaster: false, locations, activeLocation: locations[0],
        rolesByLocation: { [DUB]: 'manager', [NOEMAIL]: 'manager', [OTHER]: 'manager' },
        assignmentsByLocation: { [DUB]: mk({ email: true }), [NOEMAIL]: mk({ email: false }), [OTHER]: mk({ email: true }) },
      },
      enabledOrgIds: ['org-1'],
      mcpAccessAnywhere: true,
    },
  }
}

function makeDb(tables = {}) {
  const queries = []
  const db = {
    rpc: vi.fn(async () => ({ data: [], error: null })),
    from: vi.fn((table) => {
      const q = { table, calls: [] }
      queries.push(q)
      const answer = () => {
        const t = typeof tables[table] === 'function' ? tables[table](q) : tables[table]
        return t ?? { data: [], error: null }
      }
      const b = {}
      for (const m of ['select', 'eq', 'in', 'neq', 'order', 'limit', 'is']) {
        b[m] = (...args) => { q.calls.push([m, ...args]); return b }
      }
      b.maybeSingle = async () => answer()
      b.then = (res, rej) => Promise.resolve(answer()).then(res, rej)
      return b
    }),
  }
  return { db, on: (t) => queries.filter((q) => q.table === t) }
}
const run = (tool, input, db) => runTool(tool, input, auth(), { db, nowMs: NOW_MS })

const campaign = (over = {}) => ({
  id: CAMP, location_id: DUB, name: 'Autumn', subject: 'Hi', preview_text: 'p', from_name: 'UN1T', reply_to: null,
  html_content: '<p>hello</p>', audience_filter: FILTER, agent_blocks: null, created_via: 'web', status: 'draft',
  scheduled_at: null, last_error: null, created_at: '2031-07-01T00:00:00Z',
  total_recipients: 5, total_sent: 5, total_delivered: 5, total_opened: 2, total_clicked: 1,
  total_bounced: 0, total_complained: 0, total_unsubscribed: 0,
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  emailAudienceCounts.mockResolvedValue(COUNTS)
  pendingApproval.mockResolvedValue(null)
  describeFromAddress.mockResolvedValue({ sends_as: 'hello@un1t.test' })
  loadCampaignRecipientStats.mockResolvedValue({ ok: false, byCampaign: new Map(), error: null })
  listLandingMediaForUser.mockResolvedValue({ items: [] })
})

describe('email read tools', () => {
  it('every email tool is refused without the email permission at the studio', async () => {
    const { db } = makeDb()
    const inputs = [
      [listEmailSegments, {}], [countEmailAudience, { filter: FILTER }], [listEmailImages, {}],
      [listEmailCampaigns, {}], [getEmailCampaign, { campaign_id: CAMP }],
    ]
    for (const [tool, input] of inputs) {
      const r = await run(tool, { ...input, studio_id: NOEMAIL }, db)
      expect(r).toMatchObject({ ok: false, code: 'forbidden' })
    }
  })

  it("get_email_campaign answers the same not_found for another studio's campaign and a random uuid", async () => {
    const { db, on } = makeDb({ campaigns: { data: null, error: null } })
    const a = await run(getEmailCampaign, { campaign_id: CAMP }, db)
    const b = await run(getEmailCampaign, { campaign_id: '0b6d5d8e-6f0c-4a49-9a8e-2b8f0c6d9999' }, db)
    expect(a).toEqual({ ok: false, code: 'not_found', message: 'Campaign not found.' })
    expect(b).toEqual(a)
    expect(on('campaigns')[0].calls).toContainEqual(['eq', 'location_id', DUB])
    expect(loadCampaignRecipientStats).not.toHaveBeenCalled()
  })

  it('count_email_audience needs exactly one of segment_id and filter', async () => {
    const { db } = makeDb()
    expect(await run(countEmailAudience, {}, db)).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(await run(countEmailAudience, { segment_id: SEG, filter: FILTER }, db)).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(emailAudienceCounts).not.toHaveBeenCalled()
  })

  it('count_email_audience counts a valid filter and notes the frequency cap', async () => {
    const { db } = makeDb()
    const r = await run(countEmailAudience, { filter: FILTER }, db)
    expect(r.ok).toBe(true)
    expect(r.data).toMatchObject({ matched: 10, eligible: 8, excluded: COUNTS.excluded })
    expect(r.data.note).toMatch(/frequency cap/i)
    expect(emailAudienceCounts).toHaveBeenCalledWith(db, { filter: FILTER, locationId: DUB })
  })

  it('count_email_audience counts a saved segment read at this studio', async () => {
    const { db, on } = makeDb({ contact_segments: { data: { id: SEG, location_id: DUB, filter: FILTER }, error: null } })
    const r = await run(countEmailAudience, { segment_id: SEG }, db)
    expect(r.ok).toBe(true)
    expect(on('contact_segments')[0].calls).toContainEqual(['eq', 'location_id', DUB])
    expect(emailAudienceCounts).toHaveBeenCalledWith(db, { filter: FILTER, locationId: DUB })
  })

  it('count_email_audience refuses a filter with no rows', async () => {
    const { db } = makeDb()
    for (const filter of [{}, { logic: 'and', filters: [] }, { filters: [{ field: '', op: 'eq' }] }]) {
      expect(await run(countEmailAudience, { filter }, db)).toMatchObject({ ok: false, code: 'invalid_input' })
    }
    expect(await run(countEmailAudience, { filter: { filters: [{ field: 'nope', op: 'eq', value: 1 }] } }, db))
      .toMatchObject({ ok: false, code: 'invalid_input' })
    expect(emailAudienceCounts).not.toHaveBeenCalled()
  })

  it('count_email_audience answers not_found for a segment at another studio', async () => {
    const { db } = makeDb({ contact_segments: { data: null, error: null } })
    expect(await run(countEmailAudience, { segment_id: SEG }, db)).toEqual({ ok: false, code: 'not_found', message: expect.any(String) })
    expect(emailAudienceCounts).not.toHaveBeenCalled()
  })

  it('list_email_images returns only this studio\'s images', async () => {
    listLandingMediaForUser.mockResolvedValue({
      items: [
        { url: 'https://x/a.png', name: 'a.png', location_id: DUB },
        { url: 'https://x/b.png', name: 'b.png', location_id: OTHER },
        { url: 'https://x/c.png', name: 'c.png', location_id: null },
      ],
    })
    const { db } = makeDb()
    const r = await run(listEmailImages, {}, db)
    expect(r.data).toEqual({ images: [{ url: 'https://x/a.png', name: 'a.png' }], capped: false })
    expect(listLandingMediaForUser).toHaveBeenCalledWith(db, expect.objectContaining({ id: ME }), { kind: 'image' })
  })

  it('list_email_segments lists the studio\'s segments', async () => {
    const { db, on } = makeDb({ contact_segments: { data: [{ id: SEG, name: 'Lapsed', description: 'd' }], error: null } })
    const r = await run(listEmailSegments, {}, db)
    expect(r.data).toEqual({ segments: [{ id: SEG, name: 'Lapsed', description: 'd' }], capped: false })
    expect(on('contact_segments')[0].calls).toContainEqual(['eq', 'location_id', DUB])
  })

  it('list_email_campaigns caps at 50 and marks capped', async () => {
    const rows = Array.from({ length: 51 }, (_, i) => campaign({ id: `0b6d5d8e-6f0c-4a49-9a8e-2b8f0c6d${String(i).padStart(4, '0')}`, status: 'sent' }))
    const { db, on } = makeDb({ campaigns: { data: rows, error: null } })
    const r = await run(listEmailCampaigns, { status: 'sent' }, db)
    expect(r.data.campaigns).toHaveLength(50)
    expect(r.data.capped).toBe(true)
    expect(on('campaigns')[0].calls).toContainEqual(['eq', 'location_id', DUB])
    expect(on('campaigns')[0].calls).toContainEqual(['eq', 'status', 'sent'])
    expect(r.data.campaigns[0]).toEqual(expect.objectContaining({ sent: 5, open_rate: 0.4, click_rate: 0.2 }))
    expect(loadCampaignRecipientStats).toHaveBeenCalledWith(db, rows.slice(0, 50).map((c) => c.id))
  })

  it('get_email_campaign returns no recipient-level fields and loads stats only for the scoped id', async () => {
    const { db } = makeDb({ campaigns: { data: campaign({ status: 'sent' }), error: null } })
    const r = await run(getEmailCampaign, { campaign_id: CAMP }, db)
    expect(r.ok).toBe(true)
    expect(loadCampaignRecipientStats).toHaveBeenCalledTimes(1)
    expect(loadCampaignRecipientStats).toHaveBeenCalledWith(db, [CAMP])
    expect(r.data.results).toMatchObject({ sent: 5, opened: 2 })
    expect(r.data.campaign.sends_as).toBe('hello@un1t.test')
    expect(r.data.audience).toBeNull()
    expect(r.data.approval_waiting).toBeNull()
    const json = JSON.stringify(r.data)
    for (const k of ['html_content', 'audience_filter', 'agent_blocks']) expect(json).not.toContain(k)
  })

  it('get_email_campaign reports a draft with audience counts, approval, and the agent body state', async () => {
    const html = '<p>agent</p>'
    const blocks = [{ type: 'text' }]
    const agent_blocks = { v: 1, blocks, html_sha256: createHash('sha256').update(html).digest('hex') }
    const approval = { send_at: 'x', expires_at: 'y', audience_eligible: 8 }
    pendingApproval.mockResolvedValue(approval)
    const { db } = makeDb({ campaigns: { data: campaign({ html_content: html, agent_blocks, created_via: 'mcp' }), error: null } })
    const r = await run(getEmailCampaign, { campaign_id: CAMP }, db)
    expect(r.data).toMatchObject({ blocks, body_edited_in_crm: false, audience: COUNTS, approval_waiting: approval, results: null })
    expect(pendingApproval).toHaveBeenCalledWith(db, CAMP, NOW_MS)
    expect(loadCampaignRecipientStats).not.toHaveBeenCalled()

    const edited = makeDb({ campaigns: { data: campaign({ html_content: '<p>changed</p>', agent_blocks }), error: null } })
    expect((await run(getEmailCampaign, { campaign_id: CAMP }, edited.db)).data.body_edited_in_crm).toBe(true)
    const never = makeDb({ campaigns: { data: campaign({ agent_blocks: null }), error: null } })
    const n = await run(getEmailCampaign, { campaign_id: CAMP }, never.db)
    expect(n.data).toMatchObject({ blocks: null, body_edited_in_crm: false })
  })

  it("get_email_campaign's sends_as honours the campaign's from_email, else the studio default", async () => {
    describeFromAddress.mockImplementation(async (_db, _loc, requested) => ({ sends_as: requested || 'studio@un1t.test' }))
    const a = makeDb({ campaigns: { data: campaign({ from_email: 'news@un1t.test' }), error: null } })
    expect((await run(getEmailCampaign, { campaign_id: CAMP }, a.db)).data.campaign.sends_as).toBe('news@un1t.test')
    expect(describeFromAddress).toHaveBeenLastCalledWith(a.db, DUB, 'news@un1t.test')
    const b = makeDb({ campaigns: { data: campaign({ from_email: null }), error: null } })
    expect((await run(getEmailCampaign, { campaign_id: CAMP }, b.db)).data.campaign.sends_as).toBe('studio@un1t.test')
  })

  it('get_email_campaign counts the stored filter with blank rows stripped', async () => {
    const stored = { logic: 'and', filters: [{ field: '', op: 'eq' }, ...FILTER.filters] }
    const { db } = makeDb({ campaigns: { data: campaign({ audience_filter: stored }), error: null } })
    const r = await run(getEmailCampaign, { campaign_id: CAMP }, db)
    expect(emailAudienceCounts).toHaveBeenCalledWith(db, { filter: FILTER, locationId: DUB })
    expect(r.data.audience).toEqual(COUNTS)
  })

  it("count_email_audience's description names every AUDIENCE_FIELDS key", () => {
    for (const key of Object.keys(AUDIENCE_FIELDS)) expect(countEmailAudience.description).toContain(key)
  })

  it('htmlSha256 is the sha256 hex of the html', () => {
    expect(htmlSha256('abc')).toBe(createHash('sha256').update('abc').digest('hex'))
  })

  it('the five tools are registered in order after get_appointments', () => {
    const names = TOOLS.map((t) => t.name)
    const i = names.indexOf('get_appointments')
    expect(names.slice(i + 1, i + 6)).toEqual([
      'list_email_segments', 'count_email_audience', 'list_email_images', 'list_email_campaigns', 'get_email_campaign',
    ])
  })
})
