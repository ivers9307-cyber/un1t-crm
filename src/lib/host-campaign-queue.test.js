// QSTASH.8 — contract of the shared host-campaign chunk processor.
//
// processHostCampaignChunk is the ONE claim-before-send implementation
// shared by the send-host-campaigns sweeper cron and the QStash
// host-campaigns worker (which self-chains one chunk per delivery).
// These tests lock down:
//
//   1. The claim CAS — pending→claimed conditioned on status still
//      'pending', so an overlapping consumer claims disjoint rows.
//      LOAD-BEARING: weaken it and a cron/worker race double-sends.
//   2. The kill switch — sender_domain_verified is re-checked on EVERY
//      chunk and an unverified campaign is 'halted' (stays 'sending',
//      nothing sent, nothing finalised) rather than failed.
//   3. The send-time consent re-check (global + per-host suppression)
//      before any Postmark call.
//   4. Finalisation only when NOTHING is pending AND NOTHING is claimed
//      (in flight elsewhere) — and never off an errored count query
//      (a null count reads as 0; finalising on it would kill a live
//      campaign / clobber sent_count).
//   5. The status contract the worker's chaining decision keys on:
//      chunk_sent(remaining) / drained / halted / skipped / failed.
//
// The Supabase client is faked with the chainable thenable recorder
// (campaign-sender.test.js style) — no DB.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./postmark.js', async (importOriginal) => ({
  ...(await importOriginal()), // real applyMergeTags — substitution is part of the send contract
  sendEmail: vi.fn(),
}))
vi.mock('./app-url.js', () => ({ getAppUrl: () => 'https://crm.test' }))
vi.mock('./host-unsubscribe.js', () => ({ signHostUnsubToken: vi.fn(() => 'tok') }))
vi.mock('./host-campaign-email.js', () => ({ renderHostCampaignHtml: vi.fn(() => '<html>rendered</html>') }))
vi.mock('./log.js', () => ({ logError: vi.fn() }))

import { sendEmail } from './postmark.js'
import { logError } from './log.js'
import { processHostCampaignChunk, BATCH_SIZE } from './host-campaign-queue.js'

// ── chainable fake ─────────────────────────────────────────────────
function makeDb(route) {
  const statements = []
  const db = {
    from(table) {
      const state = { table, ops: [] }
      statements.push(state)
      const b = new Proxy({}, {
        get(_, method) {
          if (method === 'then') {
            const p = Promise.resolve(route(state) ?? {})
            return p.then.bind(p)
          }
          return (...args) => { state.ops.push({ method, args }); return b }
        },
      })
      return b
    },
  }
  return { db, statements }
}

const op = (state, method) => state.ops.find((o) => o.method === method)
const hasEq = (state, col, val) => state.ops.some((o) => o.method === 'eq' && o.args[0] === col && o.args[1] === val)

// ── fixtures ───────────────────────────────────────────────────────
const CAMPAIGN_ID = 'a0000000-0000-0000-0000-0000000000c1'
const HOST_ID = 'b0000000-0000-0000-0000-0000000000h1'

const CAMPAIGN = {
  id: CAMPAIGN_ID, host_id: HOST_ID, subject: 'Race week',
  body_html: '<p>Hi</p>', status: 'sending', recipient_count: 3, sent_count: 0,
}
const HOST = {
  id: HOST_ID, name: 'Dublin Runners', email: 'club@runners.ie',
  sender_email: 'news@runners.ie', sender_name: 'Dublin Runners CC',
  sender_domain_verified: true, postmark_stream_id: 'colm-events',
}
const emailableContact = (id, email) => ({
  id, email, email_marketing: true, email_status: 'active', email_suppressed_at: null,
})

/**
 * Configurable route for the standard statement shapes the lib issues.
 * cfg fields: campaign, campaignErr, host, hostErr, candidates, claimed,
 * contacts, suppressions, pendingLeft, claimedLeft, sentCount, plus
 * *Err overrides for the count queries.
 */
function routeFor(cfg) {
  return (state) => {
    const first = state.ops[0]
    if (state.table === 'host_campaigns') {
      if (first.method === 'select') {
        return { data: 'campaign' in cfg ? cfg.campaign : CAMPAIGN, error: cfg.campaignErr ?? null }
      }
      return { data: [{ id: CAMPAIGN_ID }], error: null } // finalise / sent_count updates
    }
    if (state.table === 'event_hosts') {
      return { data: 'host' in cfg ? cfg.host : HOST, error: cfg.hostErr ?? null }
    }
    if (state.table === 'contacts') return { data: cfg.contacts ?? [], error: cfg.contactsErr ?? null }
    if (state.table === 'host_email_suppressions') return { data: cfg.suppressions ?? [], error: null }
    if (state.table === 'host_contacts') return { data: cfg.hostContacts ?? [], error: cfg.hostContactsErr ?? null }
    if (state.table === 'host_campaign_sends') {
      if (first.method === 'select' && first.args[1]?.head) {
        const statusEq = state.ops.find((o) => o.method === 'eq' && o.args[0] === 'status')
        if (statusEq?.args[1] === 'sent') return { count: cfg.sentCount ?? 0, error: cfg.sentCountErr ?? null }
        if (statusEq?.args[1] === 'pending') return { count: cfg.pendingLeft ?? 0, error: cfg.pendingLeftErr ?? null }
        if (statusEq?.args[1] === 'claimed') return { count: cfg.claimedLeft ?? 0, error: cfg.claimedLeftErr ?? null }
      }
      if (first.method === 'select') return { data: cfg.candidates ?? [], error: cfg.candidatesErr ?? null }
      if (first.method === 'update' && op(state, 'select')) {
        return { data: cfg.claimed ?? [], error: cfg.claimErr ?? null } // claim CAS
      }
      return { data: null, error: null } // per-row sent/failed stamps
    }
    return {}
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  sendEmail.mockResolvedValue({ messageId: 'pm-1' })
})

describe('BATCH_SIZE', () => {
  it('claims at most 50 rows per chunk — the cron batch the chain paces by', () => {
    expect(BATCH_SIZE).toBe(50)
  })
})

describe('processHostCampaignChunk — eligibility and kill switch', () => {
  it("skips a campaign that is not in 'sending' (already finalised or unknown id)", async () => {
    const { db, statements } = makeDb(routeFor({ campaign: null }))
    const result = await processHostCampaignChunk(db, CAMPAIGN_ID)
    expect(result).toEqual({ status: 'skipped' })
    // Eligibility is part of the fetch, not a later check.
    const fetch = statements.find((s) => s.table === 'host_campaigns')
    expect(hasEq(fetch, 'id', CAMPAIGN_ID)).toBe(true)
    expect(hasEq(fetch, 'status', 'sending')).toBe(true)
    expect(statements.some((s) => s.table === 'host_campaign_sends')).toBe(false)
  })

  it('fails (retryable) when the campaign load errors', async () => {
    const { db } = makeDb(routeFor({ campaignErr: { message: 'boom' } }))
    const result = await processHostCampaignChunk(db, CAMPAIGN_ID)
    expect(result.status).toBe('failed')
    expect(result.error).toContain('boom')
  })

  it('marks an orphaned campaign (host row gone) terminally failed → drained', async () => {
    const { db, statements } = makeDb(routeFor({ host: null }))
    const result = await processHostCampaignChunk(db, CAMPAIGN_ID)
    expect(result.status).toBe('drained')
    const update = statements.find((s) => s.table === 'host_campaigns' && op(s, 'update'))
    expect(op(update, 'update').args[0]).toEqual({ status: 'failed' })
    expect(hasEq(update, 'status', 'sending')).toBe(true) // CAS — never clobber a terminal state
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it.each([
    ['unverified domain', { ...HOST, sender_domain_verified: false }],
    ['missing sender_email', { ...HOST, sender_email: null }],
  ])('halts on the kill switch (%s): nothing claimed, nothing sent, campaign untouched', async (_label, host) => {
    const { db, statements } = makeDb(routeFor({ host }))
    const result = await processHostCampaignChunk(db, CAMPAIGN_ID)
    expect(result.status).toBe('halted')
    expect(result.error).toBeUndefined()
    expect(statements.some((s) => s.table === 'host_campaign_sends')).toBe(false)
    expect(statements.some((s) => s.table === 'host_campaigns' && op(s, 'update'))).toBe(false)
    expect(sendEmail).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalled() // paused is operator-visible
  })

  it('re-checks the host on every call — the kill switch stops an in-flight campaign', async () => {
    const { db, statements } = makeDb(routeFor({
      candidates: [], pendingLeft: 3, claimedLeft: 0,
    }))
    await processHostCampaignChunk(db, CAMPAIGN_ID)
    const hostIdx = statements.findIndex((s) => s.table === 'event_hosts')
    const sendsIdx = statements.findIndex((s) => s.table === 'host_campaign_sends')
    expect(hostIdx).toBeGreaterThan(-1)
    expect(hostIdx).toBeLessThan(sendsIdx)
  })
})

describe('processHostCampaignChunk — claim and send', () => {
  const twoCandidates = {
    candidates: [{ id: 's1' }, { id: 's2' }],
    claimed: [
      { id: 's1', contact_id: 'c1', email: 'a@x.ie' },
      { id: 's2', contact_id: 'c2', email: 'b@x.ie' },
    ],
    contacts: [emailableContact('c1', 'a@x.ie'), emailableContact('c2', 'b@x.ie')],
    hostContacts: [
      { contact_id: 'c1', marketing_consent: true },
      { contact_id: 'c2', marketing_consent: true },
    ],
    pendingLeft: 5, claimedLeft: 0, sentCount: 2,
  }

  it('claims via CAS (pending→claimed conditioned on pending) and sends the claimed rows', async () => {
    const { db, statements } = makeDb(routeFor(twoCandidates))
    const result = await processHostCampaignChunk(db, CAMPAIGN_ID)
    expect(result.status).toBe('chunk_sent')
    expect(result.remaining).toBe(5)
    expect(result.sent).toBe(2)
    expect(result.failed).toBe(0)

    const cand = statements.find((s) => s.table === 'host_campaign_sends' && op(s, 'select')?.args[0] === 'id')
    expect(hasEq(cand, 'campaign_id', CAMPAIGN_ID)).toBe(true)
    expect(hasEq(cand, 'status', 'pending')).toBe(true)
    expect(op(cand, 'limit').args[0]).toBe(BATCH_SIZE)

    const claim = statements.find((s) => s.table === 'host_campaign_sends' && op(s, 'update') && op(s, 'select'))
    expect(op(claim, 'update').args[0]).toMatchObject({ status: 'claimed' })
    expect(op(claim, 'update').args[0].claimed_at).toBeTruthy()
    expect(op(claim, 'in').args).toEqual(['id', ['s1', 's2']])
    expect(hasEq(claim, 'status', 'pending')).toBe(true) // the CAS — only rows we won come back

    expect(sendEmail).toHaveBeenCalledTimes(2)
    expect(sendEmail.mock.calls[0][0]).toMatchObject({
      to: 'a@x.ie',
      from: '"Dublin Runners CC" <news@runners.ie>',
      replyTo: 'club@runners.ie',
      subject: 'Race week',
      stream: 'broadcast',
      tag: 'host-campaign',
    })

    const sentStamps = statements.filter((s) => s.table === 'host_campaign_sends'
      && op(s, 'update')?.args[0]?.status === 'sent')
    expect(sentStamps).toHaveLength(2)

    const refresh = statements.find((s) => s.table === 'host_campaigns' && op(s, 'update'))
    expect(op(refresh, 'update').args[0]).toEqual({ sent_count: 2 })
  })

  it('terminally fails host-consent-revoked rows without sending them', async () => {
    const { db, statements } = makeDb(routeFor({
      ...twoCandidates,
      hostContacts: [
        { contact_id: 'c1', marketing_consent: true },
        { contact_id: 'c2', marketing_consent: false },
      ],
    }))
    const result = await processHostCampaignChunk(db, CAMPAIGN_ID)
    expect(result.sent).toBe(1)
    expect(result.failed).toBe(1)
    expect(sendEmail).toHaveBeenCalledTimes(1)
    expect(sendEmail.mock.calls[0][0].to).toBe('a@x.ie')
    const revoked = statements.find((s) => s.table === 'host_campaign_sends'
      && op(s, 'update')?.args[0]?.status === 'failed' && op(s, 'in'))
    expect(op(revoked, 'in').args).toEqual(['id', ['s2']])
  })

  it('fails per-host-suppressed rows too (the footer unsubscribe)', async () => {
    const { db } = makeDb(routeFor({ ...twoCandidates, suppressions: [{ contact_id: 'c2' }] }))
    const result = await processHostCampaignChunk(db, CAMPAIGN_ID)
    expect(result.sent).toBe(1)
    expect(result.failed).toBe(1)
    expect(sendEmail).toHaveBeenCalledTimes(1)
  })

  it('a per-row send error marks that row failed and the batch continues', async () => {
    sendEmail.mockRejectedValueOnce(new Error('postmark 500')).mockResolvedValue({ messageId: 'pm-2' })
    const { db, statements } = makeDb(routeFor(twoCandidates))
    const result = await processHostCampaignChunk(db, CAMPAIGN_ID)
    expect(result.status).toBe('chunk_sent')
    expect(result.sent).toBe(1)
    expect(result.failed).toBe(1)
    const failedStamp = statements.find((s) => s.table === 'host_campaign_sends'
      && op(s, 'update')?.args[0]?.status === 'failed' && hasEq(s, 'id', 's1'))
    expect(failedStamp).toBeTruthy()
  })

  it('fails (retryable) when the claim CAS errors', async () => {
    const { db } = makeDb(routeFor({ ...twoCandidates, claimErr: { message: 'claim broke' } }))
    const result = await processHostCampaignChunk(db, CAMPAIGN_ID)
    expect(result.status).toBe('failed')
    expect(result.error).toContain('claim broke')
    expect(sendEmail).not.toHaveBeenCalled()
  })
})

describe('processHostCampaignChunk — finalisation', () => {
  const drainedBatch = {
    candidates: [{ id: 's1' }],
    claimed: [{ id: 's1', contact_id: 'c1', email: 'a@x.ie' }],
    contacts: [emailableContact('c1', 'a@x.ie')],
    pendingLeft: 0, claimedLeft: 0, sentCount: 3,
  }

  it("finalises to 'sent' (with sent_at) once nothing is pending or claimed", async () => {
    const { db, statements } = makeDb(routeFor(drainedBatch))
    const result = await processHostCampaignChunk(db, CAMPAIGN_ID)
    expect(result.status).toBe('drained')
    const finalise = statements.filter((s) => s.table === 'host_campaigns' && op(s, 'update'))
      .find((s) => op(s, 'update').args[0].status)
    expect(op(finalise, 'update').args[0]).toMatchObject({ status: 'sent', sent_count: 3 })
    expect(op(finalise, 'update').args[0].sent_at).toBeTruthy()
    expect(hasEq(finalise, 'status', 'sending')).toBe(true) // CAS against a concurrent finaliser
  })

  it("finalises to 'failed' when every row failed (nothing delivered)", async () => {
    const { db, statements } = makeDb(routeFor({ ...drainedBatch, sentCount: 0 }))
    sendEmail.mockRejectedValue(new Error('postmark down'))
    const result = await processHostCampaignChunk(db, CAMPAIGN_ID)
    expect(result.status).toBe('drained')
    const finalise = statements.filter((s) => s.table === 'host_campaigns' && op(s, 'update'))
      .find((s) => op(s, 'update').args[0].status)
    expect(op(finalise, 'update').args[0]).toMatchObject({ status: 'failed', sent_count: 0 })
    expect(op(finalise, 'update').args[0].sent_at).toBeUndefined()
  })

  it('does NOT finalise while another consumer still holds claimed rows', async () => {
    const { db, statements } = makeDb(routeFor({
      candidates: [], pendingLeft: 0, claimedLeft: 2,
    }))
    const result = await processHostCampaignChunk(db, CAMPAIGN_ID)
    expect(result).toMatchObject({ status: 'chunk_sent', remaining: 0, sent: 0, failed: 0 })
    expect(statements.some((s) => s.table === 'host_campaigns' && op(s, 'update'))).toBe(false)
  })

  it('a count-query error fails the chunk instead of mis-finalising (null count reads as 0)', async () => {
    const { db, statements } = makeDb(routeFor({
      candidates: [], pendingLeft: null, pendingLeftErr: { message: 'count blew up' }, claimedLeft: 0,
    }))
    const result = await processHostCampaignChunk(db, CAMPAIGN_ID)
    expect(result.status).toBe('failed')
    expect(result.error).toContain('count blew up')
    expect(statements.some((s) => s.table === 'host_campaigns' && op(s, 'update'))).toBe(false)
  })

  it('a sent_count refresh error fails the chunk instead of clobbering sent_count to 0', async () => {
    const { db, statements } = makeDb(routeFor({
      candidates: [{ id: 's1' }],
      claimed: [{ id: 's1', contact_id: 'c1', email: 'a@x.ie' }],
      contacts: [emailableContact('c1', 'a@x.ie')],
      sentCount: null, sentCountErr: { message: 'count query died' },
    }))
    const result = await processHostCampaignChunk(db, CAMPAIGN_ID)
    expect(result.status).toBe('failed')
    expect(statements.some((s) => s.table === 'host_campaigns' && op(s, 'update'))).toBe(false)
  })
})

describe('processHostCampaignChunk — HOST-CONSENT.1', () => {
  const claimedRows = [{ id: 's1', contact_id: 'c1', email: 'a@x.ie' }]
  const base = {
    candidates: [{ id: 's1' }], claimed: claimedRows,
    contacts: [emailableContact('c1', 'a@x.ie')],
    hostContacts: [{ contact_id: 'c1', marketing_consent: true }],
  }

  it('sends marketing on the HOST stream (postmarkStream) with the internal broadcast stream and the unsubscribe URL', async () => {
    const { db } = makeDb(routeFor(base))
    await processHostCampaignChunk(db, CAMPAIGN_ID)
    expect(sendEmail).toHaveBeenCalledTimes(1)
    const call = sendEmail.mock.calls[0][0]
    expect(call.stream).toBe('broadcast')
    expect(call.postmarkStream).toBe('colm-events')
    expect(call.unsubscribeUrl).toBe('https://crm.test/unsubscribe/host/tok')
    expect(call.metadata).toMatchObject({ host_campaign_id: CAMPAIGN_ID, host_id: HOST_ID, contact_id: 'c1' })
  })

  it('utility stays on outbound with no postmarkStream and no unsubscribe header URL', async () => {
    const { db } = makeDb(routeFor({ ...base, campaign: { ...CAMPAIGN, email_type: 'utility' }, contacts: [{ ...emailableContact('c1', 'a@x.ie'), email_administrative: true }] }))
    await processHostCampaignChunk(db, CAMPAIGN_ID)
    const call = sendEmail.mock.calls[0][0]
    expect(call.stream).toBe('outbound')
    expect(call.postmarkStream).toBeUndefined()
    expect(call.unsubscribeUrl).toBeUndefined()
  })

  it('halts a marketing campaign when the host has no stream (nothing sent, nothing finalised)', async () => {
    const { db, statements } = makeDb(routeFor({ ...base, host: { ...HOST, postmark_stream_id: null } }))
    const r = await processHostCampaignChunk(db, CAMPAIGN_ID)
    expect(r).toEqual({ status: 'halted', sent: 0, failed: 0 })
    expect(sendEmail).not.toHaveBeenCalled()
    expect(statements.some((s) => s.table === 'host_campaign_sends')).toBe(false)
  })

  it('a utility campaign still sends when the host has no stream', async () => {
    const { db } = makeDb(routeFor({ ...base, host: { ...HOST, postmark_stream_id: null }, campaign: { ...CAMPAIGN, email_type: 'utility' }, contacts: [{ ...emailableContact('c1', 'a@x.ie'), email_administrative: true }] }))
    await processHostCampaignChunk(db, CAMPAIGN_ID)
    expect(sendEmail).toHaveBeenCalledTimes(1)
  })

  it('marks a claimed row failed when host consent is false, even with UN1T consent true', async () => {
    const { db, statements } = makeDb(routeFor({ ...base, hostContacts: [{ contact_id: 'c1', marketing_consent: false }] }))
    await processHostCampaignChunk(db, CAMPAIGN_ID)
    expect(sendEmail).not.toHaveBeenCalled()
    const failed = statements.find((s) => s.table === 'host_campaign_sends' && op(s, 'update')?.args[0]?.status === 'failed')
    expect(failed).toBeTruthy()
  })

  it('sends to a contact opted OUT of UN1T marketing but consented to the host', async () => {
    const { db } = makeDb(routeFor({ ...base, contacts: [{ ...emailableContact('c1', 'a@x.ie'), email_marketing: false }] }))
    await processHostCampaignChunk(db, CAMPAIGN_ID)
    expect(sendEmail).toHaveBeenCalledTimes(1)
  })

  it('scopes the host consent re-check to the campaign host and the claimed contacts', async () => {
    const { db, statements } = makeDb(routeFor(base))
    await processHostCampaignChunk(db, CAMPAIGN_ID)
    const q = statements.find((s) => s.table === 'host_contacts')
    expect(q.ops.some((o) => o.method === 'eq' && o.args[0] === 'host_id' && o.args[1] === HOST_ID)).toBe(true)
    expect(q.ops.some((o) => o.method === 'in' && o.args[0] === 'contact_id')).toBe(true)
    expect(op(q, 'select').args[0]).toMatch(/marketing_consent/)
  })
})

describe('processHostCampaignChunk — HOST-METRICS.1', () => {
  const base = { candidates: [{ id: 's1' }], claimed: [{ id: 's1', contact_id: 'c1', email: 'a@x.ie' }], contacts: [emailableContact('c1', 'a@x.ie')], hostContacts: [{ contact_id: 'c1', marketing_consent: true }] }
  it('stamps postmark_message_id on the sent row', async () => {
    const { db, statements } = makeDb(routeFor(base))
    await processHostCampaignChunk(db, CAMPAIGN_ID)
    const sentUpd = statements.find((s) => s.table === 'host_campaign_sends' && op(s, 'update')?.args[0]?.status === 'sent')
    expect(op(sentUpd, 'update').args[0]).toMatchObject({ postmark_message_id: 'pm-1' })
  })
  it('a consent-revoked row carries the gate reason', async () => {
    const { db, statements } = makeDb(routeFor({ ...base, hostContacts: [{ contact_id: 'c1', marketing_consent: false }] }))
    await processHostCampaignChunk(db, CAMPAIGN_ID)
    const failed = statements.find((s) => s.table === 'host_campaign_sends' && op(s, 'update')?.args[0]?.status === 'failed')
    expect(op(failed, 'update').args[0]).toEqual({ status: 'failed', failed_reason: 'no_host_consent' })
    expect(op(failed, 'in').args).toEqual(['id', ['s1']])
  })
  it('a suppressed row reads host_unsubscribed', async () => {
    const { db, statements } = makeDb(routeFor({ ...base, suppressions: [{ contact_id: 'c1' }] }))
    await processHostCampaignChunk(db, CAMPAIGN_ID)
    const failed = statements.find((s) => s.table === 'host_campaign_sends' && op(s, 'update')?.args[0]?.status === 'failed')
    expect(op(failed, 'update').args[0].failed_reason).toBe('host_unsubscribed')
  })
  it('mixed reasons in one chunk → one update per reason', async () => {
    const cfg = { ...base,
      candidates: [{ id: 's1' }, { id: 's2' }, { id: 's3' }],
      claimed: [{ id: 's1', contact_id: 'c1', email: 'a@x.ie' }, { id: 's2', contact_id: 'c2', email: 'b@x.ie' }, { id: 's3', contact_id: 'c3', email: 'c@x.ie' }],
      contacts: [emailableContact('c1', 'a@x.ie'), { ...emailableContact('c2', 'b@x.ie'), email_status: 'bounced' }, emailableContact('c3', 'c@x.ie')],
      hostContacts: [{ contact_id: 'c1', marketing_consent: false }, { contact_id: 'c2', marketing_consent: true }, { contact_id: 'c3', marketing_consent: true }],
    }
    const { db, statements } = makeDb(routeFor(cfg))
    const r = await processHostCampaignChunk(db, CAMPAIGN_ID)
    const failedUpdates = statements.filter((s) => s.table === 'host_campaign_sends' && op(s, 'update')?.args[0]?.status === 'failed')
    expect(failedUpdates.map((s) => [op(s, 'update').args[0].failed_reason, op(s, 'in').args[1]])).toEqual([['no_host_consent', ['s1']], ['mailbox_blocked', ['s2']]])
    expect(r.failed).toBe(2)
    expect(sendEmail).toHaveBeenCalledTimes(1)
  })
  it('a thrown send writes send_error', async () => {
    sendEmail.mockRejectedValueOnce(new Error('422 inactive recipient'))
    const { db, statements } = makeDb(routeFor(base))
    await processHostCampaignChunk(db, CAMPAIGN_ID)
    const failed = statements.find((s) => s.table === 'host_campaign_sends' && op(s, 'update')?.args[0]?.status === 'failed')
    expect(op(failed, 'update').args[0]).toEqual({ status: 'failed', failed_reason: 'send_error' })
    expect(op(failed, 'eq').args).toEqual(['id', 's1'])
  })
})
