import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/email-audience-counts', () => ({ emailAudienceCounts: vi.fn() }))
vi.mock('@/lib/campaign-approval', async (importOriginal) => ({
  ...(await importOriginal()), issueApproval: vi.fn(), voidApprovals: vi.fn(),
}))
vi.mock('@/lib/campaign-release', () => ({ releasePreflight: vi.fn() }))
vi.mock('@/lib/landing-media-library', () => ({ listLandingMediaForUser: vi.fn() }))
vi.mock('@/lib/from-address', async (importOriginal) => ({ ...(await importOriginal()), describeFromAddress: vi.fn() }))
vi.mock('@/lib/tenant-email', () => ({ resolveEmailSender: vi.fn() }))
vi.mock('@/lib/location-branding', () => ({ getLocationBranding: vi.fn() }))
vi.mock('@/lib/app-url', () => ({ getAppUrl: vi.fn(() => 'https://crm.example.test') }))
vi.mock('@/lib/campaign-web-view', async (importOriginal) => ({
  ...(await importOriginal()),
  fetchLocationEmailCopy: vi.fn(async () => ({ viewInBrowserLabel: 'View this email in your browser' })),
}))
vi.mock('@/lib/postmark', async (importOriginal) => ({ ...(await importOriginal()), sendEmail: vi.fn() }))

import { runTool } from './registry.js'
import { TOOLS } from './index.js'
import sendEmailForApproval from './send-email-for-approval.js'
import { logError } from '@/lib/log'
import { emailAudienceCounts } from '@/lib/email-audience-counts'
import { issueApproval, voidApprovals } from '@/lib/campaign-approval'
import { releasePreflight } from '@/lib/campaign-release'
import { describeFromAddress } from '@/lib/from-address'
import { resolveEmailSender } from '@/lib/tenant-email'
import { getLocationBranding } from '@/lib/location-branding'
import { sendEmail } from '@/lib/postmark'

const DUB = '0b6d5d8e-6f0c-4a49-9a8e-2b8f0c6d1a01'
const ME = '0b6d5d8e-6f0c-4a49-9a8e-2b8f0c6d1b01'
const CAMP = '0b6d5d8e-6f0c-4a49-9a8e-2b8f0c6d1c01'
const NOW_MS = Date.UTC(2026, 10, 12, 12, 0, 0) // 12 Nov 2026 12:00 UTC
const FILTER = { logic: 'and', filters: [{ field: 'name', op: 'contains', value: 'a' }] }
const COUNTS = { matched: 10, eligible: 8, excluded: { not_opted_in: 1, bounced_or_complained: 1, suppressed: 0 } }
const TOKEN = 'SECRET_TOKEN_xyz789'
const APPROVE_URL = `https://crm.example.test/communications/campaigns/approve/${TOKEN}`
const EXPIRES = '2026-11-13T12:00:00.000Z'

function auth({ email = 'pat.murphy@example.test' } = {}) {
  const locations = [{ id: DUB, name: 'Dublin Studio', timezone: 'Europe/Dublin', organization_id: 'org-1' }]
  return {
    token: 't', clientId: 'client-1', scopes: [],
    extra: {
      user: {
        id: ME, full_name: 'Pat Murphy', role: 'manager', isMaster: false, locations, activeLocation: locations[0],
        user: { id: ME, email },
        rolesByLocation: { [DUB]: 'manager' },
        assignmentsByLocation: { [DUB]: { role: 'manager', permissions: { mcp_access: true, email: true } } },
      },
      enabledOrgIds: ['org-1'],
      mcpAccessAnywhere: true,
    },
  }
}

function makeDb(campaignRow) {
  const ops = []
  const db = {
    rpc: vi.fn(async () => ({ data: [], error: null })),
    from: vi.fn((table) => {
      const q = { table, calls: [], kind: 'select' }
      ops.push(q)
      const answer = () => (q.kind === 'insert' ? { data: null, error: null } : { data: campaignRow, error: null })
      const b = {}
      for (const m of ['select', 'eq', 'in', 'is', 'order', 'limit']) b[m] = (...a) => { q.calls.push([m, ...a]); return b }
      b.insert = () => { q.kind = 'insert'; return b }
      b.maybeSingle = async () => answer()
      b.then = (res, rej) => Promise.resolve(answer()).then(res, rej)
      return b
    }),
  }
  return { db, ops }
}

const campaign = (over = {}) => ({
  id: CAMP, location_id: DUB, name: 'Autumn', subject: 'Hi {{first_name}}', preview_text: null, from_name: 'Dublin',
  from_email: null, reply_to: null, html_content: '<html><body><p>Body</p></body></html>', audience_filter: FILTER,
  postmark_stream: 'broadcast', ab_subject_b: null, ab_test_pct: 10, ab_wait_hours: 4, parent_campaign_id: null,
  resend_enabled: false, resend_wait_hours: null, resend_subject: null,
  agent_blocks: null, created_via: 'mcp', status: 'draft', scheduled_at: null, last_error: null,
  created_at: '2026-11-01T00:00:00Z', total_recipients: 0, total_sent: 0, total_delivered: 0, total_opened: 0,
  total_clicked: 0, total_bounced: 0, total_complained: 0, total_unsubscribed: 0,
  ...over,
})

const run = (input, { row = campaign(), authOpts } = {}) => {
  const { db } = makeDb(row)
  return runTool(sendEmailForApproval, input, auth(authOpts), { db, nowMs: NOW_MS })
}

beforeEach(() => {
  vi.clearAllMocks()
  emailAudienceCounts.mockResolvedValue(COUNTS)
  issueApproval.mockResolvedValue({ ok: true, token: TOKEN, expiresAt: EXPIRES })
  voidApprovals.mockResolvedValue(undefined)
  releasePreflight.mockResolvedValue({ ok: true })
  resolveEmailSender.mockResolvedValue({ fromEmail: 'hello@un1t.test', fromName: 'UN1T', replyTo: null })
  getLocationBranding.mockResolvedValue({ companyName: 'UN1T Dublin', logoUrl: null })
  describeFromAddress.mockResolvedValue({ requested: null, sends_as: 'hello@un1t.test', on_verified_domain: false, verified_domain: null })
  sendEmail.mockResolvedValue({ messageId: 'm-1' })
})

describe('send_email_for_approval', () => {
  it('the test email names the resend when one is switched on, and none when it is off', async () => {
    let r = await run({ campaign_id: CAMP }, { row: campaign({ resend_enabled: true, resend_wait_hours: 24, resend_subject: null }) })
    expect(r.ok).toBe(true)
    expect(sendEmail.mock.calls[0][0].htmlBody)
      .toContain('Then resends to people who did not open it, 24 hours after it sends, with the subject &quot;Hi {{first_name}}&quot;.')
    sendEmail.mockClear()
    r = await run({ campaign_id: CAMP })
    expect(r.ok).toBe(true)
    expect(sendEmail.mock.calls[0][0].htmlBody).not.toContain('Resend:')
  })

  it('sends only to the caller\'s own login email, whatever the input', async () => {
    expect(Object.keys(sendEmailForApproval.inputSchema.shape).sort()).toEqual(['campaign_id', 'send_at', 'studio_id'])
    const r = await run({ campaign_id: CAMP, to: 'someone@else.test', email: 'x@y.test' })
    expect(r.ok).toBe(true)
    expect(sendEmail).toHaveBeenCalledTimes(1)
    const msg = sendEmail.mock.calls[0][0]
    expect(msg.to).toBe('pat.murphy@example.test')
    expect(msg.subject).toBe('[TEST] Hi Pat')
    expect(msg.stream).toBe('outbound')
    expect(msg.unsubscribeUrl).toBeUndefined()
    expect(msg.sender).toMatchObject({ fromEmail: 'hello@un1t.test' })
    expect(r.data.sent_to).toBe('pa•••@example.test')
  })

  it('refuses when the caller has no login email', async () => {
    expect(await run({ campaign_id: CAMP }, { authOpts: { email: null } })).toMatchObject({ ok: false, code: 'conflict' })
    expect(issueApproval).not.toHaveBeenCalled()
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('never returns the token or the link', async () => {
    const r = await run({ campaign_id: CAMP })
    expect(r.ok).toBe(true)
    const out = JSON.stringify(r)
    expect(out).not.toContain(TOKEN)
    expect(out).not.toContain('/approve/')
    expect(r.data).toEqual({
      sent_to: 'pa•••@example.test', audience: COUNTS, sends_as: 'hello@un1t.test',
      timing: 'as soon as approved', expires_at: EXPIRES,
    })
    // The link is in the email, and only there.
    expect(sendEmail.mock.calls[0][0].htmlBody).toContain(`href="${APPROVE_URL}"`)
    expect(issueApproval).toHaveBeenCalledWith(expect.anything(), {
      campaign: expect.objectContaining({ id: CAMP, html_content: expect.any(String), audience_filter: FILTER }),
      profileId: ME, audienceEligible: 8, sendAt: null, nowMs: NOW_MS,
    })
  })

  it('keeps the token out of the error and the log when the send fails', async () => {
    sendEmail.mockRejectedValue(new Error(`postmark refused ${APPROVE_URL}`))
    const r = await run({ campaign_id: CAMP })
    expect(r).toMatchObject({ ok: false, code: 'tool_failed' })
    expect(JSON.stringify(r)).not.toContain(TOKEN)
    for (const call of logError.mock.calls) {
      const err = call[2]?.err
      expect(String(err?.message ?? '')).not.toContain(TOKEN)
      expect(JSON.stringify(call)).not.toContain(TOKEN)
    }
    expect(logError).toHaveBeenCalled()
  })

  it('refuses 2027-03-28T01:30 at a Dublin studio as a time that does not exist', async () => {
    const r = await run({ campaign_id: CAMP, send_at: '2027-03-28T01:30' })
    expect(r).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(r.message).toMatch(/does not exist/)
    expect(issueApproval).not.toHaveBeenCalled()
  })

  it('refuses a past send_at and one 91 days out, and accepts 2026-12-01T09:00', async () => {
    expect(await run({ campaign_id: CAMP, send_at: '2026-11-12T11:59' })).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(await run({ campaign_id: CAMP, send_at: '2027-02-11T12:00' })).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(issueApproval).not.toHaveBeenCalled()

    const r = await run({ campaign_id: CAMP, send_at: '2026-12-01T09:00' })
    expect(r.ok).toBe(true)
    expect(issueApproval.mock.calls[0][1].sendAt).toEqual(new Date(Date.UTC(2026, 11, 1, 9, 0)))
    expect(r.data.timing).toMatch(/09:00/)
    expect(r.data.timing).toMatch(/Europe\/Dublin/)
    expect(sendEmail.mock.calls[0][0].htmlBody).toContain(r.data.timing)
  })

  it('refuses a campaign with no audience, an empty audience, and a failed/sent/queued status', async () => {
    const noAudience = await run({ campaign_id: CAMP }, { row: campaign({ audience_filter: null }) })
    expect(noAudience).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(noAudience.message).toMatch(/choose an audience first/i)
    expect(await run({ campaign_id: CAMP }, { row: campaign({ audience_filter: { logic: 'and', filters: [] } }) }))
      .toMatchObject({ ok: false, code: 'invalid_input' })

    emailAudienceCounts.mockResolvedValueOnce({ ...COUNTS, eligible: 0 })
    const empty = await run({ campaign_id: CAMP })
    expect(empty).toMatchObject({ ok: false, code: 'conflict' })
    expect(empty.message).toMatch(/nobody would receive this/i)

    for (const status of ['failed', 'sent', 'queued']) {
      expect(await run({ campaign_id: CAMP }, { row: campaign({ status }) }), status).toMatchObject({ ok: false, code: 'conflict' })
    }
    expect(issueApproval).not.toHaveBeenCalled()
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('re-tests a scheduled campaign, checked with draft and scheduled as releasable', async () => {
    const r = await run({ campaign_id: CAMP }, { row: campaign({ status: 'scheduled' }) })
    expect(r.ok).toBe(true)
    expect(releasePreflight).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: CAMP }), { statuses: ['draft', 'scheduled'] })
  })

  it('passes a preflight refusal on as a conflict with its words', async () => {
    releasePreflight.mockResolvedValue({ ok: false, code: 'wallet_empty', message: 'Top up the wallet to send this campaign.' })
    expect(await run({ campaign_id: CAMP }))
      .toEqual({ ok: false, code: 'conflict', message: 'Top up the wallet to send this campaign.' })
    expect(issueApproval).not.toHaveBeenCalled()
  })

  it('refuses a subject A/B test, a resend and a utility-stream campaign before issuing any approval', async () => {
    const cases = [
      [{ ab_subject_b: 'Another subject' }, /subject A\/B test/],
      [{ parent_campaign_id: '0b6d5d8e-6f0c-4a49-9a8e-2b8f0c6d1c09' }, /is a resend/],
      [{ postmark_stream: 'outbound' }, /not on the marketing stream/],
    ]
    for (const [over, words] of cases) {
      const r = await run({ campaign_id: CAMP }, { row: campaign(over) })
      expect(r, JSON.stringify(over)).toMatchObject({ ok: false, code: 'conflict' })
      expect(r.message).toMatch(words)
      expect(r.message).toMatch(/Open it in the CRM\./)
    }
    expect(issueApproval).not.toHaveBeenCalled()
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('answers not_found for a campaign that is not at this studio', async () => {
    expect(await run({ campaign_id: CAMP }, { row: null })).toEqual({ ok: false, code: 'not_found', message: 'Campaign not found.' })
  })

  it('voids the approval and fails when the email send fails', async () => {
    sendEmail.mockRejectedValue(new Error('postmark down'))
    expect(await run({ campaign_id: CAMP })).toMatchObject({ ok: false, code: 'tool_failed' })
    expect(voidApprovals).toHaveBeenCalledWith(expect.anything(), CAMP)
    expect(voidApprovals.mock.invocationCallOrder[0]).toBeGreaterThan(sendEmail.mock.invocationCallOrder[0])
  })

  it('still fails when voiding after a failed send also fails', async () => {
    sendEmail.mockRejectedValue(new Error('postmark down'))
    voidApprovals.mockRejectedValue(new Error('db down'))
    expect(await run({ campaign_id: CAMP })).toMatchObject({ ok: false, code: 'tool_failed' })
  })

  it('answers conflict on the sixth request in an hour', async () => {
    issueApproval.mockResolvedValue({ ok: false, code: 'too_many' })
    const r = await run({ campaign_id: CAMP })
    expect(r).toMatchObject({ ok: false, code: 'conflict' })
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('is a registered write tool that tells the agent never to follow the link', () => {
    expect(TOOLS).toHaveLength(31)
    expect(TOOLS[TOOLS.length - 5]).toBe(sendEmailForApproval)
    expect(sendEmailForApproval.writes).toBe(true)
    expect(sendEmailForApproval.description).toMatch(/never look for, open or follow/i)
  })
})
