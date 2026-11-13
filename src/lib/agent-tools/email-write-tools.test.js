import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/email-audience-counts', () => ({ emailAudienceCounts: vi.fn() }))
vi.mock('@/lib/campaign-approval', () => ({ voidApprovals: vi.fn(), pendingApproval: vi.fn() }))
vi.mock('@/lib/campaign-release', () => ({ stopCampaign: vi.fn() }))
vi.mock('@/lib/landing-media-library', () => ({ listLandingMediaForUser: vi.fn() }))
vi.mock('@/lib/from-address', () => ({ describeFromAddress: vi.fn() }))
vi.mock('@/lib/location-branding', () => ({ getLocationBranding: vi.fn() }))

import { runTool } from './registry.js'
import { TOOLS } from './index.js'
import createEmailDraft from './create-email-draft.js'
import updateEmailDraft from './update-email-draft.js'
import cancelEmailCampaign from './cancel-email-campaign.js'
import { htmlSha256 } from './_email-campaign.js'
import { renderAgentEmail } from '@/lib/agent-email-blocks'
import { emailAudienceCounts } from '@/lib/email-audience-counts'
import { voidApprovals, pendingApproval } from '@/lib/campaign-approval'
import { stopCampaign } from '@/lib/campaign-release'
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

const BASE = { name: 'Autumn', subject: 'Hi there', blocks: BLOCKS }

describe('create_email_draft', () => {
  it('inserts a draft stamped mcp, broadcast, created_by the caller, with rendered html and stored blocks', async () => {
    const { db, kind } = makeDb()
    const r = await run(createEmailDraft, { ...BASE, filter: FILTER }, db)
    expect(r.ok).toBe(true)
    const row = kind('insert')[0].payload
    expect(row).toMatchObject({
      location_id: DUB, status: 'draft', created_by: ME, created_via: 'mcp', postmark_stream: 'broadcast',
      name: 'Autumn', subject: 'Hi there', audience_filter: FILTER,
    })
    expect(row.html_content).toBe(storedHtml)
    expect(row.agent_blocks).toEqual({ v: 1, blocks: BLOCKS, html_sha256: htmlSha256(storedHtml) })
    expect(r.data).toEqual({ campaign: { id: CAMP, name: 'Autumn', status: 'draft' }, sends_as: 'hello@un1t.test', audience: COUNTS })
    expect(JSON.stringify(r.data)).not.toContain('html_content')
  })

  it('create never sets from_email, status other than draft, or any ab_ field', async () => {
    const { db, kind } = makeDb()
    await run(createEmailDraft, { ...BASE }, db)
    const keys = Object.keys(kind('insert')[0].payload)
    expect(keys).not.toContain('from_email')
    expect(keys.filter((k) => k.startsWith('ab_'))).toEqual([])
    expect(kind('insert')[0].payload.status).toBe('draft')
    expect(kind('insert')[0].payload.audience_filter).toBeNull()
  })

  it('create refuses blocks with an image outside the studio library, and writes nothing', async () => {
    const { db, kind } = makeDb()
    const r = await run(createEmailDraft, { ...BASE, blocks: [{ type: 'image', url: 'https://evil.test/x.png', alt: 'x' }] }, db)
    expect(r).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(kind('insert')).toHaveLength(0)
  })

  it('create accepts an image from the studio library', async () => {
    listLandingMediaForUser.mockResolvedValue({ items: [{ url: 'https://x.test/a.png', name: 'a', location_id: DUB }] })
    const { db, kind } = makeDb()
    const r = await run(createEmailDraft, { ...BASE, blocks: [{ type: 'image', url: 'https://x.test/a.png', alt: 'a' }] }, db)
    expect(r.ok).toBe(true)
    expect(kind('insert')).toHaveLength(1)
  })

  it('create refuses a reply_to off the verified domain, naming it', async () => {
    const { db, kind } = makeDb()
    const r = await run(createEmailDraft, { ...BASE, reply_to: 'me@gmail.com' }, db)
    expect(r).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(r.message).toContain('un1t.test')
    expect(kind('insert')).toHaveLength(0)
  })

  it('create refuses any reply_to when the studio has no verified domain', async () => {
    describeFromAddress.mockResolvedValue({ requested: 'a@b.test', sends_as: null, on_verified_domain: false, verified_domain: null })
    const { db } = makeDb()
    const r = await run(createEmailDraft, { ...BASE, reply_to: 'a@b.test' }, db)
    expect(r).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(r.message).toMatch(/verified/i)
  })

  it('create and update refuse a filter with no rows', async () => {
    const { db, kind } = makeDb({ select: agentCampaign() })
    for (const filter of [{}, { logic: 'and', filters: [] }]) {
      expect(await run(createEmailDraft, { ...BASE, filter }, db)).toMatchObject({ ok: false, code: 'invalid_input' })
      expect(await run(updateEmailDraft, { campaign_id: CAMP, filter }, db)).toMatchObject({ ok: false, code: 'invalid_input' })
    }
    expect(kind('insert')).toHaveLength(0)
    expect(kind('update')).toHaveLength(0)
  })

  it('create writes resend_enabled, resend_wait_hours and resend_subject from resend', async () => {
    const { db, kind } = makeDb()
    const r = await run(createEmailDraft, { ...BASE, resend: { after_hours: 48, subject: 'Missed it, {{first_name}}?' } }, db)
    expect(r.ok).toBe(true)
    expect(kind('insert')[0].payload).toMatchObject({ resend_enabled: true, resend_wait_hours: 48, resend_subject: 'Missed it, {{first_name}}?' })
    const none = makeDb()
    await run(createEmailDraft, { ...BASE, resend: { after_hours: 24 } }, none.db)
    expect(none.kind('insert')[0].payload).toMatchObject({ resend_enabled: true, resend_wait_hours: 24, resend_subject: null })
    const off = makeDb()
    await run(createEmailDraft, { ...BASE }, off.db)
    expect(off.kind('insert')[0].payload).not.toHaveProperty('resend_enabled')
  })

  it('refuses after_hours 0 and 169, and a resend subject with {{ first_name }} or {{nope}}', async () => {
    const { db, kind } = makeDb({ select: agentCampaign() })
    for (const resend of [{ after_hours: 0 }, { after_hours: 169 }, { after_hours: 1.5 },
      { after_hours: 24, subject: 'Hi {{ first_name }}' }, { after_hours: 24, subject: 'Hi {{nope}}' }]) {
      expect(await run(createEmailDraft, { ...BASE, resend }, db), JSON.stringify(resend)).toMatchObject({ ok: false, code: 'invalid_input' })
      expect(await run(updateEmailDraft, { campaign_id: CAMP, resend }, db), JSON.stringify(resend)).toMatchObject({ ok: false, code: 'invalid_input' })
    }
    expect(kind('insert')).toHaveLength(0)
    expect(kind('update')).toHaveLength(0)
  })

  it('create is refused without the email permission', async () => {
    const { db } = makeDb()
    expect(await run(createEmailDraft, { ...BASE, studio_id: NOEMAIL }, db)).toMatchObject({ ok: false, code: 'forbidden' })
  })

  it('maps a check violation to conflict', async () => {
    const { db } = makeDb({ insert: { data: null, error: { code: '23514', message: 'x' } } })
    expect(await run(createEmailDraft, { ...BASE }, db)).toMatchObject({ ok: false, code: 'conflict' })
  })
})

describe('update_email_draft', () => {
  it('needs at least one field besides the id', async () => {
    const { db } = makeDb({ select: agentCampaign() })
    expect(await run(updateEmailDraft, { campaign_id: CAMP }, db)).toMatchObject({ ok: false, code: 'invalid_input' })
  })

  it('writes a body edit with fresh html and matching hash, scoped and compare-and-set', async () => {
    const { db, kind } = makeDb({ select: agentCampaign() })
    const next = [{ type: 'paragraph', text: 'New copy' }]
    const r = await run(updateEmailDraft, { campaign_id: CAMP, blocks: next }, db)
    expect(r.ok).toBe(true)
    const u = kind('update')[0]
    const html = renderAgentEmail({ blocks: next, branding: BRANDING })
    expect(u.payload).toMatchObject({ html_content: html, agent_blocks: { v: 1, blocks: next, html_sha256: htmlSha256(html) } })
    expect(u.calls).toContainEqual(['eq', 'id', CAMP])
    expect(u.calls).toContainEqual(['eq', 'location_id', DUB])
    expect(u.calls).toContainEqual(['in', 'status', ['draft', 'scheduled']])
    expect(voidApprovals).toHaveBeenCalledWith(db, CAMP)
  })

  it('update on a scheduled campaign writes the change, returns it to draft and voids the approval', async () => {
    const { db, kind } = makeDb({ select: agentCampaign({ status: 'scheduled', scheduled_at: '2031-08-01T10:00:00Z' }) })
    const r = await run(updateEmailDraft, { campaign_id: CAMP, subject: 'New subject' }, db)
    expect(r.ok).toBe(true)
    expect(kind('update')[0].payload).toMatchObject({ subject: 'New subject', status: 'draft', scheduled_at: null })
    expect(r.data.unscheduled).toBe(true)
    expect(r.data.note).toMatch(/draft/i)
    expect(voidApprovals).toHaveBeenCalledWith(db, CAMP)
  })

  it('a draft edit still writes status draft and scheduled_at null, for body and non-body edits', async () => {
    for (const input of [{ subject: 'S' }, { blocks: [{ type: 'paragraph', text: 'x' }] }]) {
      const { db, kind } = makeDb({ select: agentCampaign() })
      const r = await run(updateEmailDraft, { campaign_id: CAMP, ...input }, db)
      expect(kind('update')[0].payload).toMatchObject({ status: 'draft', scheduled_at: null })
      expect(r.data.unscheduled).toBe(false)
    }
  })

  it('update with resend: null switches it off; omitting resend leaves it unchanged', async () => {
    const off = makeDb({ select: agentCampaign() })
    expect((await run(updateEmailDraft, { campaign_id: CAMP, resend: null }, off.db)).ok).toBe(true)
    expect(off.kind('update')[0].payload).toMatchObject({ resend_enabled: false, resend_wait_hours: null, resend_subject: null })
    const on = makeDb({ select: agentCampaign() })
    await run(updateEmailDraft, { campaign_id: CAMP, resend: { after_hours: 72, subject: 'Again' } }, on.db)
    expect(on.kind('update')[0].payload).toMatchObject({ resend_enabled: true, resend_wait_hours: 72, resend_subject: 'Again' })
    const left = makeDb({ select: agentCampaign() })
    await run(updateEmailDraft, { campaign_id: CAMP, subject: 'S' }, left.db)
    const payload = left.kind('update')[0].payload
    for (const k of ['resend_enabled', 'resend_wait_hours', 'resend_subject']) expect(payload).not.toHaveProperty(k)
  })

  it('update refuses a resend on a campaign that is itself a resend', async () => {
    const { db, kind } = makeDb({ select: agentCampaign({ parent_campaign_id: '0b6d5d8e-6f0c-4a49-9a8e-2b8f0c6d9998' }) })
    const r = await run(updateEmailDraft, { campaign_id: CAMP, resend: { after_hours: 24 } }, db)
    expect(r).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(r.message).toMatch(/cannot itself be resent/)
    expect(kind('update')).toHaveLength(0)
  })

  it('an update that changes only the resend still returns the campaign to draft and voids approvals', async () => {
    const { db, kind } = makeDb({ select: agentCampaign({ status: 'scheduled', scheduled_at: '2031-08-01T10:00:00Z' }) })
    const r = await run(updateEmailDraft, { campaign_id: CAMP, resend: { after_hours: 24 } }, db)
    expect(r.ok).toBe(true)
    expect(r.data.unscheduled).toBe(true)
    const u = kind('update')[0]
    expect(u.payload).toMatchObject({ status: 'draft', scheduled_at: null, resend_enabled: true, resend_wait_hours: 24 })
    expect(u.calls).toContainEqual(['in', 'status', ['draft', 'scheduled']])
    expect(voidApprovals).toHaveBeenCalledWith(db, CAMP)
  })

  it('update refuses a body edit when html_content no longer matches the stored blocks, and still allows a subject edit', async () => {
    const edited = agentCampaign({ html_content: storedHtml + '<!-- edited in CRM -->' })
    const a = makeDb({ select: edited })
    const r = await run(updateEmailDraft, { campaign_id: CAMP, blocks: BLOCKS }, a.db)
    expect(r).toEqual({ ok: false, code: 'conflict', message: 'The body was edited in the CRM. Edit the body there.' })
    expect(a.kind('update')).toHaveLength(0)

    const b = makeDb({ select: edited })
    const ok = await run(updateEmailDraft, { campaign_id: CAMP, subject: 'Fresh' }, b.db)
    expect(ok.ok).toBe(true)
    const keys = Object.keys(b.kind('update')[0].payload)
    expect(keys).not.toContain('html_content')
    expect(keys).not.toContain('agent_blocks')
  })

  it('update refuses a body edit on a campaign with no agent blocks', async () => {
    const { db } = makeDb({ select: agentCampaign({ agent_blocks: null, created_via: 'web' }) })
    expect(await run(updateEmailDraft, { campaign_id: CAMP, blocks: BLOCKS }, db))
      .toMatchObject({ ok: false, code: 'conflict', message: 'The body was edited in the CRM. Edit the body there.' })
  })

  it('update answers conflict for sent, sending, queued and failed', async () => {
    for (const status of ['sent', 'sending', 'queued', 'failed']) {
      const { db, kind } = makeDb({ select: agentCampaign({ status }) })
      const r = await run(updateEmailDraft, { campaign_id: CAMP, subject: 'x' }, db)
      expect(r).toMatchObject({ ok: false, code: 'conflict' })
      expect(r.message).toContain(status)
      expect(kind('update')).toHaveLength(0)
    }
    const { db } = makeDb({ select: agentCampaign({ status: 'failed' }) })
    expect((await run(updateEmailDraft, { campaign_id: CAMP, subject: 'x' }, db)).message).toMatch(/open it in the CRM/i)
  })

  it("update answers not_found for another studio's campaign", async () => {
    const { db, ops } = makeDb({ select: null })
    expect(await run(updateEmailDraft, { campaign_id: CAMP, subject: 'x' }, db))
      .toEqual({ ok: false, code: 'not_found', message: 'Campaign not found.' })
    expect(ops[0].calls).toContainEqual(['eq', 'location_id', DUB])
  })

  it('zero rows updated is a conflict naming the current status, and nothing is voided', async () => {
    const { db } = makeDb({ select: agentCampaign(), update: { data: [], error: null } })
    expect(await run(updateEmailDraft, { campaign_id: CAMP, subject: 'x' }, db)).toMatchObject({ ok: false, code: 'conflict' })
    expect(voidApprovals).not.toHaveBeenCalled()
  })

  it('maps a check violation to conflict', async () => {
    const { db } = makeDb({ select: agentCampaign(), update: { data: null, error: { code: '23514', message: 'x' } } })
    expect(await run(updateEmailDraft, { campaign_id: CAMP, subject: 'x' }, db)).toMatchObject({ ok: false, code: 'conflict' })
  })

  it('replaces the audience only when a segment or filter is given', async () => {
    const { db, kind } = makeDb({ select: agentCampaign() })
    await run(updateEmailDraft, { campaign_id: CAMP, subject: 'x' }, db)
    expect(Object.keys(kind('update')[0].payload)).not.toContain('audience_filter')
    const b = makeDb({ select: agentCampaign() })
    const f2 = { logic: 'and', filters: [{ field: 'name', op: 'contains', value: 'zed' }] }
    await run(updateEmailDraft, { campaign_id: CAMP, filter: f2 }, b.db)
    expect(b.kind('update')[0].payload.audience_filter).toEqual(f2)
  })

  it('refuses a reply_to off the verified domain', async () => {
    const { db } = makeDb({ select: agentCampaign() })
    expect(await run(updateEmailDraft, { campaign_id: CAMP, reply_to: 'me@gmail.com' }, db)).toMatchObject({ ok: false, code: 'invalid_input' })
  })

  it('lets a voiding failure fail the tool', async () => {
    voidApprovals.mockRejectedValue(new Error('boom'))
    const { db } = makeDb({ select: agentCampaign() })
    expect(await run(updateEmailDraft, { campaign_id: CAMP, subject: 'x' }, db))
      .toMatchObject({ ok: false, code: 'conflict', message: expect.stringContaining('The edit was saved') })
  })
})

describe('cancel_email_campaign', () => {
  it('loads at the studio first, then stops it', async () => {
    stopCampaign.mockResolvedValue({ ok: true, outcome: 'back_to_draft', status: 'draft', cancel_requested_at: null })
    const { db, ops } = makeDb({ select: agentCampaign({ status: 'scheduled' }) })
    const r = await run(cancelEmailCampaign, { campaign_id: CAMP }, db)
    expect(r).toMatchObject({ ok: true, data: { outcome: 'back_to_draft' } })
    expect(ops[0].calls).toContainEqual(['eq', 'location_id', DUB])
    expect(stopCampaign).toHaveBeenCalledWith(db, expect.objectContaining({ id: CAMP, status: 'scheduled' }))
  })

  it('maps stop_requested', async () => {
    stopCampaign.mockResolvedValue({ ok: true, outcome: 'stop_requested', status: 'sending', cancel_requested_at: 'now' })
    const { db } = makeDb({ select: agentCampaign({ status: 'sending' }) })
    expect((await run(cancelEmailCampaign, { campaign_id: CAMP }, db)).data.outcome).toBe('stop_requested')
  })

  it('maps not_stoppable to conflict and an error to a failed call', async () => {
    stopCampaign.mockResolvedValue({ ok: false, code: 'not_stoppable', message: 'This campaign is sent, so there is nothing to stop.', current_status: 'sent' })
    const { db } = makeDb({ select: agentCampaign({ status: 'sent' }) })
    expect(await run(cancelEmailCampaign, { campaign_id: CAMP }, db))
      .toEqual({ ok: false, code: 'conflict', message: 'This campaign is sent, so there is nothing to stop.' })
    stopCampaign.mockResolvedValue({ ok: false, code: 'error', message: 'db down' })
    expect(await run(cancelEmailCampaign, { campaign_id: CAMP }, db)).toMatchObject({ ok: false, code: 'tool_failed' })
  })

  it('answers not_found without stopping anything for a campaign elsewhere', async () => {
    const { db } = makeDb({ select: null })
    expect(await run(cancelEmailCampaign, { campaign_id: CAMP }, db)).toMatchObject({ ok: false, code: 'not_found' })
    expect(stopCampaign).not.toHaveBeenCalled()
    expect(voidApprovals).not.toHaveBeenCalled()
  })

  it('withdraws any approval after a successful stop, so a link still in the inbox is dead', async () => {
    for (const [status, stop] of [
      ['scheduled', { ok: true, outcome: 'back_to_draft', status: 'draft', cancel_requested_at: null }],
      ['sending', { ok: true, outcome: 'stop_requested', status: 'sending', cancel_requested_at: 'now' }],
    ]) {
      voidApprovals.mockClear()
      stopCampaign.mockResolvedValue(stop)
      const { db } = makeDb({ select: agentCampaign({ status }) })
      expect(await run(cancelEmailCampaign, { campaign_id: CAMP }, db), status).toMatchObject({ ok: true })
      expect(voidApprovals).toHaveBeenCalledWith(db, CAMP)
      expect(voidApprovals.mock.invocationCallOrder[0]).toBeGreaterThan(stopCampaign.mock.invocationCallOrder.at(-1))
    }
  })

  it('says the stop landed but the withdrawal failed when voiding throws after a stop', async () => {
    stopCampaign.mockResolvedValue({ ok: true, outcome: 'back_to_draft', status: 'draft', cancel_requested_at: null })
    voidApprovals.mockRejectedValue(new Error('db down'))
    const { db } = makeDb({ select: agentCampaign({ status: 'scheduled' }) })
    expect(await run(cancelEmailCampaign, { campaign_id: CAMP }, db)).toEqual({
      ok: false, code: 'conflict',
      message: 'The campaign was stopped, but withdrawing the earlier approval failed. Send a new test before anything is approved.',
    })
  })

  it('a plain draft with a live approval: withdraws it and answers approval_withdrawn', async () => {
    stopCampaign.mockResolvedValue({ ok: false, code: 'not_stoppable', message: 'This campaign is draft, so there is nothing to stop.', current_status: 'draft' })
    pendingApproval.mockResolvedValue({ send_at: null, expires_at: 'x', audience_eligible: 8 })
    const { db } = makeDb({ select: agentCampaign({ status: 'draft' }) })
    expect(await run(cancelEmailCampaign, { campaign_id: CAMP }, db))
      .toEqual({ ok: true, data: { outcome: 'approval_withdrawn', status: 'draft' } })
    expect(pendingApproval).toHaveBeenCalledWith(db, CAMP, NOW_MS)
    expect(voidApprovals).toHaveBeenCalledWith(db, CAMP)
  })

  it('a plain draft with no live approval keeps the existing conflict', async () => {
    stopCampaign.mockResolvedValue({ ok: false, code: 'not_stoppable', message: 'This campaign is draft, so there is nothing to stop.', current_status: 'draft' })
    const { db } = makeDb({ select: agentCampaign({ status: 'draft' }) })
    expect(await run(cancelEmailCampaign, { campaign_id: CAMP }, db))
      .toEqual({ ok: false, code: 'conflict', message: 'This campaign is draft, so there is nothing to stop.' })
  })

  it('cancel switches off a pending resend on a sent campaign, and refuses once the child exists', async () => {
    const sent = agentCampaign({ status: 'sent', resend_enabled: true, resend_wait_hours: 24 })
    const pending = makeDb({ select: sent, child: { data: null, error: null } })
    const r = await run(cancelEmailCampaign, { campaign_id: CAMP }, pending.db)
    expect(r).toEqual({ ok: true, data: { outcome: 'resend_cancelled', status: 'sent' } })
    const child = pending.ops.find((o) => o.calls.some((c) => c[1] === 'parent_campaign_id'))
    expect(child.calls).toContainEqual(['eq', 'location_id', DUB])
    const u = pending.kind('update')[0]
    expect(u.payload).toEqual({ resend_enabled: false })
    for (const c of [['eq', 'id', CAMP], ['eq', 'location_id', DUB], ['eq', 'status', 'sent'], ['eq', 'resend_enabled', true]]) {
      expect(u.calls).toContainEqual(c)
    }
    expect(stopCampaign).not.toHaveBeenCalled()
    expect(voidApprovals).not.toHaveBeenCalled()

    const CHILD = '0b6d5d8e-6f0c-4a49-9a8e-2b8f0c6d1c99'
    const started = makeDb({ select: sent, child: { data: { id: CHILD }, error: null } })
    expect(await run(cancelEmailCampaign, { campaign_id: CAMP }, started.db))
      .toEqual({ ok: false, code: 'conflict', message: `The resend has already started. Cancel it instead: ${CHILD}.` })
    expect(started.kind('update')).toHaveLength(0)

    const unreadable = makeDb({ select: sent, child: { data: null, error: { message: 'down' } } })
    expect(await run(cancelEmailCampaign, { campaign_id: CAMP }, unreadable.db)).toMatchObject({ ok: false, code: 'tool_failed' })
    expect(unreadable.kind('update')).toHaveLength(0)

    const raced = makeDb({ select: sent, child: { data: null, error: null }, update: { data: [], error: null } })
    expect(await run(cancelEmailCampaign, { campaign_id: CAMP }, raced.db)).toMatchObject({ ok: false, code: 'conflict' })
  })

  it('a sent campaign is never voided through cancel', async () => {
    stopCampaign.mockResolvedValue({ ok: false, code: 'not_stoppable', message: 'This campaign is sent, so there is nothing to stop.', current_status: 'sent' })
    const { db } = makeDb({ select: agentCampaign({ status: 'sent' }) })
    expect(await run(cancelEmailCampaign, { campaign_id: CAMP }, db)).toMatchObject({ ok: false, code: 'conflict' })
    expect(pendingApproval).not.toHaveBeenCalled()
    expect(voidApprovals).not.toHaveBeenCalled()
  })
})

describe('write tool registration', () => {
  it('all three are registered, write tools, and warn to confirm', () => {
    for (const t of [createEmailDraft, updateEmailDraft, cancelEmailCampaign]) {
      expect(TOOLS).toContain(t)
      expect(t.writes).toBe(true)
      expect(t.description.endsWith('This writes to the CRM: confirm with the user first.')).toBe(true)
    }
  })
})
