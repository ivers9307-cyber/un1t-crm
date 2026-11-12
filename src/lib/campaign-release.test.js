// MCPEMAIL.1 — src/lib/campaign-release.js: the one copy of the rules that
// release a campaign (send now / schedule) and stop one. The send, schedule
// and stop routes call it, and so will the approve route, so these rules can
// never drift between the CRM's own buttons and the Claude approval path.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeFakeDb, campaignDbSequence, writesOf, CAMPAIGN_ID, LOC_A } from '@/lib/campaign-session-access.test-helpers.js'

vi.mock('@/lib/usage-caps', () => ({ getEmailCapStatus: vi.fn(async () => ({ capped: false })) }))
vi.mock('@/lib/wallet-enforcement', () => ({ checkSpend: vi.fn(async () => ({ allow: true, reason: 'unpinned' })) }))

import { RELEASABLE_STATUSES, releasePreflight, releaseCampaign, stopCampaign } from './campaign-release.js'
import { getEmailCapStatus } from '@/lib/usage-caps'
import { checkSpend } from '@/lib/wallet-enforcement'

const NOW = new Date('2026-10-01T09:00:00.000Z')
const LATER = new Date('2026-10-02T09:00:00.000Z')
const campaign = (over = {}) => ({
  id: CAMPAIGN_ID, location_id: LOC_A, status: 'draft', subject: 'Last chance', html_content: '<p>Hi</p>', ...over,
})
// A db whose every write touches the one row, and whose reads answer `row`.
const okDb = (row = campaign()) => makeFakeDb((call) => (call.op === 'select'
  ? { data: row, error: null }
  : { data: [{ id: CAMPAIGN_ID }], error: null }))

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => { vi.useRealTimers() })

describe('releasePreflight', () => {
  it('releasable statuses are draft, scheduled and failed', () => {
    expect(RELEASABLE_STATUSES).toEqual(['draft', 'scheduled', 'failed'])
  })

  it('preflight refuses sent, sending, queued and cancelled with the status named', async () => {
    for (const status of ['sent', 'sending', 'queued', 'cancelled']) {
      const r = await releasePreflight(okDb(), campaign({ status }))
      expect(r, status).toEqual({ ok: false, code: 'status', message: `Campaign is '${status}', cannot send` })
    }
    for (const status of RELEASABLE_STATUSES) {
      expect(await releasePreflight(okDb(), campaign({ status })), status).toEqual({ ok: true })
    }
    expect(getEmailCapStatus).toHaveBeenCalledWith({ locationId: LOC_A }, { db: expect.anything() })
    expect(checkSpend).toHaveBeenCalledWith(expect.anything(), LOC_A, 'email_send', 'marketing')
  })

  it('preflight honours a narrower statuses list', async () => {
    const r = await releasePreflight(okDb(), campaign({ status: 'failed' }), { statuses: ['draft', 'scheduled'] })
    expect(r).toEqual({ ok: false, code: 'status', message: "Campaign is 'failed', cannot send" })
  })

  it('preflight refuses an empty subject and an empty body with the routes\' existing messages', async () => {
    for (const subject of [null, '', '   ']) {
      expect(await releasePreflight(okDb(), campaign({ subject }))).toEqual({
        ok: false, code: 'no_subject', message: 'This campaign has no subject — add one before sending.',
      })
    }
    for (const html_content of [null, '', '   ']) {
      expect(await releasePreflight(okDb(), campaign({ html_content }))).toEqual({
        ok: false, code: 'no_body',
        message: 'This campaign has no email body — nothing was queued. Open it in the editor and add content.',
      })
    }
    expect(getEmailCapStatus).not.toHaveBeenCalled()
  })

  it('preflight refuses at the org hard cap before reading the wallet, and on an empty wallet', async () => {
    getEmailCapStatus.mockResolvedValueOnce({ capped: true, capSends: 1000, monthSends: 1000 })
    expect(await releasePreflight(okDb(), campaign())).toEqual({
      ok: false, code: 'email_hard_cap',
      message: 'Monthly email hard cap reached (1,000 of 1,000 sends this month). Raise or clear the cap in org settings to send this campaign.',
    })
    expect(checkSpend).not.toHaveBeenCalled()

    checkSpend.mockResolvedValueOnce({ allow: false, reason: 'wallet_empty' })
    expect(await releasePreflight(okDb(), campaign())).toEqual({
      ok: false, code: 'wallet_empty',
      message: 'Monthly email allowance is used up and the prepaid wallet is empty — marketing sends are paused. Top up the wallet to send this campaign.',
    })
  })

  it('preflight passes when the cap and wallet reads throw (fail open)', async () => {
    getEmailCapStatus.mockRejectedValueOnce(new Error('metering down'))
    checkSpend.mockRejectedValueOnce(new Error('billing down'))
    expect(await releasePreflight(okDb(), campaign())).toEqual({ ok: true })
  })
})

describe('releaseCampaign', () => {
  it('release queues now and clears scheduled_at, cancel_requested_at and last_error', async () => {
    const db = okDb()
    expect(await releaseCampaign(db, campaign())).toEqual({ ok: true, status: 'queued', scheduled_at: null })
    const writes = writesOf(db)
    expect(writes).toHaveLength(1)
    expect(writes[0].table).toBe('campaigns')
    expect(writes[0].payload).toEqual({ status: 'queued', cancel_requested_at: null, scheduled_at: null, last_error: null })
    expect(writes[0].filters).toEqual([['eq', 'id', CAMPAIGN_ID], ['in', 'status', ['draft', 'scheduled', 'failed']]])
    expect(writes[0].columns).toBe('id')
  })

  it('release schedules at sendAt', async () => {
    const db = okDb()
    expect(await releaseCampaign(db, campaign(), { sendAt: LATER }))
      .toEqual({ ok: true, status: 'scheduled', scheduled_at: LATER.toISOString() })
    const [w] = writesOf(db)
    expect(w.payload).toEqual({ status: 'scheduled', scheduled_at: LATER.toISOString(), cancel_requested_at: null })
    expect(w.filters).toEqual([['eq', 'id', CAMPAIGN_ID], ['in', 'status', ['draft', 'scheduled', 'failed']]])
  })

  it('release answers conflict when the compare-and-set touches no row', async () => {
    const db = campaignDbSequence([campaign({ status: 'sending' })], () => ({ data: [], error: null }))
    expect(await releaseCampaign(db, campaign())).toEqual({
      ok: false, code: 'conflict', message: "The campaign's status changed; reload.", current_status: 'sending',
    })
    expect(writesOf(db)).toHaveLength(1)
  })

  it('release answers error with the write\'s message', async () => {
    const db = makeFakeDb(() => ({ data: null, error: { message: 'boom' } }))
    expect(await releaseCampaign(db, campaign())).toEqual({ ok: false, code: 'error', message: 'boom' })
  })

  it('release with expectUpdatedAt pins the row version too; an edit since makes it a conflict', async () => {
    const READ_AT = '2026-10-01T08:59:00.123456+00:00'
    // Answers like Postgres: the row's updated_at moved (an edit landed), so the eq misses.
    const db = makeFakeDb((call) => {
      if (call.op === 'select') return { data: { status: 'draft' }, error: null }
      const pinned = call.filters.find(([op, col]) => op === 'eq' && col === 'updated_at')
      return { data: pinned && pinned[2] === READ_AT ? [{ id: CAMPAIGN_ID }] : [], error: null }
    })
    const r = await releaseCampaign(db, campaign(), { statuses: ['draft', 'scheduled'], expectUpdatedAt: '2026-10-01T08:58:00+00:00' })
    expect(r).toMatchObject({ ok: false, code: 'conflict', current_status: 'draft' })
    expect(writesOf(db)[0].filters).toEqual([
      ['eq', 'id', CAMPAIGN_ID], ['in', 'status', ['draft', 'scheduled']], ['eq', 'updated_at', '2026-10-01T08:58:00+00:00'],
    ])
    expect(await releaseCampaign(db, campaign(), { statuses: ['draft', 'scheduled'], expectUpdatedAt: READ_AT }))
      .toEqual({ ok: true, status: 'queued', scheduled_at: null })
  })

  it('release refuses an unusable expectUpdatedAt without writing (a pin never silently drops)', async () => {
    for (const expectUpdatedAt of [null, '', 123]) {
      const db = okDb()
      const r = await releaseCampaign(db, campaign(), { expectUpdatedAt })
      expect(r).toMatchObject({ ok: false, code: 'error' })
      expect(writesOf(db)).toEqual([])
    }
  })

  it('release without expectUpdatedAt adds no updated_at filter (existing callers unchanged)', async () => {
    const db = okDb()
    await releaseCampaign(db, campaign(), { sendAt: LATER })
    expect(writesOf(db)[0].filters.some(([, col]) => col === 'updated_at')).toBe(false)
  })

  it('release with statuses [draft, scheduled] never touches a failed campaign', async () => {
    // The fake answers like Postgres: the row is 'failed', so the IN filter excludes it.
    const db = makeFakeDb((call) => {
      if (call.op === 'select') return { data: { status: 'failed' }, error: null }
      const statusFilter = call.filters.find(([op, col]) => op === 'in' && col === 'status')
      return { data: statusFilter[2].includes('failed') ? [{ id: CAMPAIGN_ID }] : [], error: null }
    })
    const r = await releaseCampaign(db, campaign({ status: 'failed' }), { statuses: ['draft', 'scheduled'] })
    expect(r).toMatchObject({ ok: false, code: 'conflict', current_status: 'failed' })
    expect(writesOf(db)[0].filters).toEqual([['eq', 'id', CAMPAIGN_ID], ['in', 'status', ['draft', 'scheduled']]])
  })
})

describe('stopCampaign', () => {
  it('stop sends a scheduled campaign back to draft and stamps a cancel request on a sending one', async () => {
    let db = okDb()
    expect(await stopCampaign(db, campaign({ status: 'scheduled' })))
      .toEqual({ ok: true, outcome: 'back_to_draft', status: 'draft', cancel_requested_at: null })
    let [w] = writesOf(db)
    expect(w.payload).toEqual({ status: 'draft', scheduled_at: null })
    expect(w.filters).toEqual([['eq', 'id', CAMPAIGN_ID], ['eq', 'status', 'scheduled']])

    db = okDb()
    expect(await stopCampaign(db, campaign({ status: 'sending' })))
      .toEqual({ ok: true, outcome: 'stop_requested', status: 'sending', cancel_requested_at: NOW.toISOString() })
    ;[w] = writesOf(db)
    expect(w.payload).toEqual({ cancel_requested_at: NOW.toISOString() })
    expect(w.filters).toEqual([['eq', 'id', CAMPAIGN_ID], ['in', 'status', ['queued', 'sending']]])
  })

  it('stop turns into a cancel request when the cron promoted the scheduled campaign in between', async () => {
    let n = 0
    const db = campaignDbSequence([campaign({ status: 'queued' })], () => (n++ === 0
      ? { data: [], error: null }
      : { data: [{ id: CAMPAIGN_ID }], error: null }))
    expect(await stopCampaign(db, campaign({ status: 'scheduled' })))
      .toEqual({ ok: true, outcome: 'stop_requested', status: 'queued', cancel_requested_at: NOW.toISOString() })
  })

  it('stop refuses any other status and a status that changed, naming the current status', async () => {
    for (const status of ['draft', 'sent', 'cancelled', 'failed']) {
      const db = okDb()
      expect(await stopCampaign(db, campaign({ status }))).toEqual({
        ok: false, code: 'not_stoppable',
        message: `This campaign is ${status}, so there is nothing to stop.`, current_status: status,
      })
      expect(writesOf(db)).toEqual([])
    }
    expect((await stopCampaign(okDb(), campaign({ status: null }))).message)
      .toBe('This campaign is in an unknown state, so there is nothing to stop.')

    const db = campaignDbSequence([campaign({ status: 'draft' })], () => ({ data: [], error: null }))
    expect(await stopCampaign(db, campaign({ status: 'scheduled' }))).toEqual({
      ok: false, code: 'not_stoppable', message: "The campaign's status changed; reload.", current_status: 'draft',
    })
  })

  it('stop answers error with the write\'s message', async () => {
    const db = makeFakeDb(() => ({ data: null, error: { message: 'boom' } }))
    expect(await stopCampaign(db, campaign({ status: 'sending' }))).toEqual({ ok: false, code: 'error', message: 'boom' })
  })
})
