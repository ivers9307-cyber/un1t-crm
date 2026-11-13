import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/email-audience-counts', () => ({ emailAudienceCounts: vi.fn() }))
vi.mock('@/lib/campaign-approval', () => ({ voidApprovals: vi.fn(), pendingApproval: vi.fn() }))
vi.mock('@/lib/campaign-release', () => ({ stopCampaign: vi.fn() }))
vi.mock('@/lib/landing-media-library', () => ({ listLandingMediaForUser: vi.fn() }))
vi.mock('@/lib/from-address', () => ({ describeFromAddress: vi.fn() }))
vi.mock('@/lib/location-branding', () => ({ getLocationBranding: vi.fn() }))

import { runTool } from './registry.js'
import duplicateEmailCampaign from './duplicate-email-campaign.js'
import { htmlSha256 } from './_email-campaign.js'
import { renderAgentEmail } from '@/lib/agent-email-blocks'
import { emailAudienceCounts } from '@/lib/email-audience-counts'
import { voidApprovals, pendingApproval } from '@/lib/campaign-approval'
import { listLandingMediaForUser } from '@/lib/landing-media-library'
import { describeFromAddress } from '@/lib/from-address'
import { getLocationBranding } from '@/lib/location-branding'

const DUB = '0b6d5d8e-6f0c-4a49-9a8e-2b8f0c6d1a01'
const NOEMAIL = '0b6d5d8e-6f0c-4a49-9a8e-2b8f0c6d1a02'
const ME = '0b6d5d8e-6f0c-4a49-9a8e-2b8f0c6d1b01'
const CAMP = '0b6d5d8e-6f0c-4a49-9a8e-2b8f0c6d1c01'
const NOW_MS = Date.UTC(2031, 6, 15, 12, 0, 0)
const FILTER = { logic: 'and', filters: [{ field: 'name', op: 'contains', value: 'a' }] }
const COUNTS = { matched: 10, eligible: 8, excluded: { not_opted_in: 1, bounced_or_complained: 1, suppressed: 0 } }
const BLOCKS = [{ type: 'heading', text: 'Hello', level: 1 }, { type: 'paragraph', text: 'Welcome back.' }]
const BRANDING = { companyName: 'Dublin Studio', logoUrl: null }

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

// answers: { select: row|null, insert: {data,error}, update: {data,error} }
function makeDb(answers = {}) {
  const ops = []
  const db = {
    rpc: vi.fn(async () => ({ data: [], error: null })),
    from: vi.fn((table) => {
      const q = { table, calls: [], kind: 'select', payload: null }
      ops.push(q)
      const answer = () => {
        if (q.kind === 'insert') return answers.insert ?? { data: [{ id: CAMP, name: q.payload?.name, status: 'draft' }], error: null }
        if (q.kind === 'update') return answers.update ?? { data: [{ id: CAMP }], error: null }
        if (answers.child !== undefined && q.calls.some((c) => c[1] === 'parent_campaign_id')) return answers.child
        return { data: answers.select ?? null, error: null }
      }
      const b = {}
      for (const m of ['select', 'eq', 'in', 'is', 'order', 'limit']) {
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
  return { db, ops, kind: (k) => ops.filter((o) => o.kind === k && o.table === 'campaigns') }
}
const run = (tool, input, db) => runTool(tool, input, auth(), { db, nowMs: NOW_MS })

const storedHtml = renderAgentEmail({ blocks: BLOCKS, branding: BRANDING })
const agentCampaign = (over = {}) => ({
  id: CAMP, location_id: DUB, name: 'Autumn', subject: 'Hi', preview_text: null, from_name: null, from_email: null,
  reply_to: null, html_content: storedHtml, audience_filter: FILTER,
  agent_blocks: { v: 1, blocks: BLOCKS, html_sha256: htmlSha256(storedHtml) },
  created_via: 'mcp', status: 'draft', scheduled_at: null, last_error: null, created_at: '2031-07-01T00:00:00Z',
  total_recipients: 0, total_sent: 0, total_delivered: 0, total_opened: 0, total_clicked: 0,
  total_bounced: 0, total_complained: 0, total_unsubscribed: 0,
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  emailAudienceCounts.mockResolvedValue(COUNTS)
  voidApprovals.mockResolvedValue(undefined)
  pendingApproval.mockResolvedValue(null)
  listLandingMediaForUser.mockResolvedValue({ items: [] })
  getLocationBranding.mockResolvedValue({ companyName: 'Dublin Studio', logoUrl: null, shortName: 'D', locationName: 'D' })
  describeFromAddress.mockImplementation(async (_db, _loc, requested) => ({
    requested: requested ?? null,
    sends_as: 'hello@un1t.test',
    on_verified_domain: typeof requested === 'string' && requested.endsWith('@un1t.test'),
    verified_domain: 'un1t.test',
  }))
})

const OTHER = '0b6d5d8e-6f0c-4a49-9a8e-2b8f0c6d1c99'
const sentSource = (over = {}) => agentCampaign({
  status: 'sent', name: 'Autumn', design_json: { d: 1 }, template_id: 'tpl-1', postmark_stream: 'broadcast',
  from_email: 'old@un1t.test', parent_campaign_id: 'p-1', resend_enabled: true, resend_wait_hours: 24, resend_subject: 'Again',
  ab_subject_b: 'B', ab_test_pct: 20, ab_wait_hours: 6, ab_winner: 'a', scheduled_at: '2031-07-02T00:00:00Z',
  total_sent: 50, ...over,
})

describe('duplicate_email_campaign', () => {
  it('copies a sent campaign as a draft stamped mcp, without parent, A/B, schedule or resend', async () => {
    const { db, kind, ops } = makeDb({ select: sentSource() })
    const r = await run(duplicateEmailCampaign, { campaign_id: CAMP }, db)
    expect(r.ok).toBe(true)
    const row = kind('insert')[0].payload
    expect(row).toMatchObject({ location_id: DUB, status: 'draft', created_by: ME, created_via: 'mcp', name: 'Copy of Autumn', subject: 'Hi' })
    expect(row.audience_filter).toEqual(FILTER)
    expect(row.resend_enabled).not.toBe(true)
    for (const k of ['parent_campaign_id', 'resend_wait_hours', 'resend_subject', 'scheduled_at', 'ab_subject_b', 'ab_test_pct', 'ab_wait_hours', 'ab_winner', 'total_sent']) {
      expect(row[k] ?? null).toBeNull()
    }
    const src = ops.find((o) => o.kind === 'select')
    expect(src.calls).toContainEqual(['eq', 'location_id', DUB])
    expect(r.data.campaign).toEqual({ id: CAMP, name: 'Copy of Autumn', status: 'draft' })
  })

  it('uses the given name', async () => {
    const { db, kind } = makeDb({ select: sentSource() })
    await run(duplicateEmailCampaign, { campaign_id: CAMP, name: 'Winter' }, db)
    expect(kind('insert')[0].payload.name).toBe('Winter')
  })

  it('keeps a Claude-written body editable and marks a CRM-built body as not editable', async () => {
    const a = makeDb({ select: sentSource() })
    const ra = await run(duplicateEmailCampaign, { campaign_id: CAMP }, a.db)
    expect(ra.data.body_editable_from_claude).toBe(true)
    expect(a.kind('insert')[0].payload.agent_blocks).toEqual(sentSource().agent_blocks)

    const edited = makeDb({ select: sentSource({ html_content: storedHtml + '<p>edited</p>' }) })
    expect((await run(duplicateEmailCampaign, { campaign_id: CAMP }, edited.db)).data.body_editable_from_claude).toBe(false)

    const crm = makeDb({ select: sentSource({ agent_blocks: null, created_via: null }) })
    const rc = await run(duplicateEmailCampaign, { campaign_id: CAMP }, crm.db)
    expect(rc.data.body_editable_from_claude).toBe(false)
    expect(crm.kind('insert')[0].payload.agent_blocks).toBeNull()
  })

  it('refuses an outbound (service) source', async () => {
    const { db, kind } = makeDb({ select: sentSource({ postmark_stream: 'outbound' }) })
    const r = await run(duplicateEmailCampaign, { campaign_id: CAMP }, db)
    expect(r).toEqual({ ok: false, code: 'conflict', message: 'This is a service email. Duplicate it in the CRM.' })
    expect(kind('insert')).toEqual([])
  })

  it("answers not_found for another studio's campaign and a random uuid alike", async () => {
    const { db, kind } = makeDb({ select: null })
    const a = await run(duplicateEmailCampaign, { campaign_id: OTHER }, db)
    const b = await run(duplicateEmailCampaign, { campaign_id: CAMP }, db)
    expect(a).toEqual({ ok: false, code: 'not_found', message: 'Campaign not found.' })
    expect(b).toEqual(a)
    expect(kind('insert')).toEqual([])
  })

  it('copies the source from_email and reports it as sends_as', async () => {
    const { db, kind } = makeDb({ select: sentSource({ from_email: 'old@un1t.test' }) })
    const r = await run(duplicateEmailCampaign, { campaign_id: CAMP }, db)
    expect(kind('insert')[0].payload.from_email).toBe('old@un1t.test')
    expect(r.data.sends_as).toBe('old@un1t.test')
  })

  it('falls back to the studio address when the source has no from_email', async () => {
    const { db } = makeDb({ select: sentSource({ from_email: null }) })
    expect((await run(duplicateEmailCampaign, { campaign_id: CAMP }, db)).data.sends_as).toBe('hello@un1t.test')
  })

  it('is refused without the email permission', async () => {
    const { db } = makeDb({ select: sentSource() })
    expect(await run(duplicateEmailCampaign, { campaign_id: CAMP, studio_id: NOEMAIL }, db)).toMatchObject({ ok: false })
  })
})
