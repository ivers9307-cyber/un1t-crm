// MAILBOX-CONNECT.5.2 — route test for the poll-imap-mailboxes cron.
//
// The sweep itself is tested in src/lib/mail/imap-poll.test.js. Only three
// things live in the route, and all three have bitten a cron in this codebase
// before: the CRON_SECRET gate (the #408 class), the heartbeat stamp (a cron
// that runs fine and reads "stale" — or worse, one that reads healthy through
// an outage), and the `ok !== false` mapping onto `success`.
//
// The fourth assertion is the one that is specific to a MULTI-TENANT cron: one
// customer's revoked app password must not mark the whole cron stale. It is
// stated here as a test because it is a judgement call, and a later reader
// looking at `failed: 3` next to a fresh heartbeat needs to see that it was
// deliberate.
//
// Since Phase 8 there is a fifth: this ONE tick sweeps BOTH lanes. The route
// says so by NOT saying anything — it passes no lane argument, so the lane
// list and its order (inbox first, then sent, on one shared budget) live in
// pollAllMailboxes where the deadline does. A route that named the lanes
// itself would be a policy decision in a wrapper that is meant to hold only
// the CRON_SECRET gate, the heartbeat and the JSON.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const fakeDb = { __brand: 'db' }

vi.mock('@/lib/supabase', () => ({ createServerClient: () => fakeDb }))
vi.mock('@/lib/mail/imap-poll', () => ({ pollAllMailboxes: vi.fn() }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(() => Promise.resolve()) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn() }))

import { GET } from './route.js'
import { pollAllMailboxes } from '@/lib/mail/imap-poll'
import { stampHeartbeat } from '@/lib/cron-heartbeat'

const ZERO_LANE = { ingested: 0, skipped: 0, failed: 0, paused: 0, unconfigured: 0 }
const DORMANT = {
  ok: true, mailboxes: 0, ingested: 0, skipped: 0, failed: 0, paused: 0,
  lanes: { inbox: { ...ZERO_LANE }, sent: { ...ZERO_LANE } },
}

function req(auth = 'Bearer test-secret') {
  return { headers: { get: (k) => (k.toLowerCase() === 'authorization' ? auth : null) } }
}

beforeEach(() => {
  process.env.CRON_SECRET = 'test-secret'
  vi.clearAllMocks()
  pollAllMailboxes.mockResolvedValue(DORMANT)
})

describe('GET /api/cron/poll-imap-mailboxes', () => {
  it('rejects a missing or wrong bearer without polling anything', async () => {
    // A poller that anyone can trigger is a way to make N IMAP connections to
    // a customer's mail server on demand.
    expect((await GET(req('Bearer nope'))).status).toBe(401)
    expect((await GET(req(''))).status).toBe(401)
    expect((await GET(req('test-secret'))).status).toBe(401) // no "Bearer " prefix
    expect(pollAllMailboxes).not.toHaveBeenCalled()
  })

  it('rejects everything when CRON_SECRET is unset, rather than letting the tick through', async () => {
    delete process.env.CRON_SECRET
    expect((await GET(req('Bearer '))).status).toBe(401)
    expect(pollAllMailboxes).not.toHaveBeenCalled()
  })

  it('stamps the heartbeat with the run counters, not a bare timestamp', async () => {
    const out = { ok: true, mailboxes: 2, ingested: 7, skipped: 1, failed: 0, paused: 0 }
    pollAllMailboxes.mockResolvedValue(out)

    const res = await GET(req())
    const body = await res.json()

    expect(pollAllMailboxes).toHaveBeenCalledWith(fakeDb)
    // The counters are the point of the second argument: a stamp without them
    // cannot tell "ran, nothing connected" from "ran, three mailboxes failing".
    expect(stampHeartbeat).toHaveBeenCalledWith('poll-imap-mailboxes', out)
    expect(body).toMatchObject({ success: true, ...out })
  })

  it('a dormant tick — nothing connected — is healthy and still stamps', async () => {
    const body = await (await GET(req())).json()
    expect(body).toMatchObject({ success: true, mailboxes: 0 })
    expect(stampHeartbeat).toHaveBeenCalledWith('poll-imap-mailboxes', DORMANT)
  })

  it('🔴 a tenant failing auth does NOT mark the cron stale', async () => {
    // The heartbeat answers "is the poller running". A revoked app password is
    // an operator action only that operator can fix; letting it stale the cron
    // would page us for their problem AND hide the tick where the poller
    // genuinely stopped. The per-mailbox surface (last_error, paused_until) is
    // what says a mailbox is broken.
    const out = { ok: true, mailboxes: 3, ingested: 4, skipped: 0, failed: 2, paused: 1 }
    pollAllMailboxes.mockResolvedValue(out)

    const body = await (await GET(req())).json()

    expect(body).toMatchObject({ success: true, failed: 2, paused: 1 })
    expect(stampHeartbeat).toHaveBeenCalledWith('poll-imap-mailboxes', out)
  })

  it('a sweep that could not read its own mailbox list does NOT stamp', async () => {
    // The one failure the health check must see: the poller cannot say whether
    // anyone's mail is arriving. One missed stamp is absorbed by the 600s
    // grace; a sustained one pages, which is exactly right.
    pollAllMailboxes.mockResolvedValue({ ok: false, reason: 'mailbox_lookup_failed', mailboxes: 0 })

    const body = await (await GET(req())).json()

    expect(body).toMatchObject({ success: false, reason: 'mailbox_lookup_failed' })
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('🔴 sweeps BOTH lanes by asking for none — the lane order lives with the budget', async () => {
    // No second cron, no vercel.json entry, no second heartbeat row: one tick
    // reads INBOX and then the account's Sent folder out of the same
    // wall-clock budget. The route passes exactly one argument, which is what
    // makes the library's DEFAULT_LANES the single place that order is decided
    // — and the order matters, because sent must never starve inbox.
    await GET(req())
    expect(pollAllMailboxes).toHaveBeenCalledWith(fakeDb)
    expect(pollAllMailboxes.mock.calls[0]).toHaveLength(1)
  })

  it('the per-lane breakdown rides into the heartbeat, not just the totals', async () => {
    // `last_outcome` is what ops read without opening the logs, and the
    // counters exist so it can tell "ran, nothing connected" from "ran, the
    // sent lane is failing on three mailboxes". Collapsing the lanes into the
    // totals alone would hide exactly the half this phase added — including
    // `unconfigured`, which is a mailbox with no Sent folder and is NOT a
    // fault. Numbers and reason codes only: no address, no host, no error.
    const out = {
      ok: true, mailboxes: 4, ingested: 9, skipped: 1, failed: 3, paused: 0,
      lanes: {
        inbox: { ingested: 8, skipped: 1, failed: 0, paused: 0, unconfigured: 0 },
        sent: { ingested: 1, skipped: 0, failed: 3, paused: 0, unconfigured: 1 },
      },
    }
    pollAllMailboxes.mockResolvedValue(out)

    const body = await (await GET(req())).json()

    expect(stampHeartbeat).toHaveBeenCalledWith('poll-imap-mailboxes', out)
    expect(body).toMatchObject({ success: true, lanes: out.lanes })
    // A sent lane failing is a per-mailbox condition like any other: it counts,
    // it does not stale the cron.
    expect(body.success).toBe(true)
  })

  it('a heartbeat that fails does not fail the tick', async () => {
    stampHeartbeat.mockRejectedValueOnce(new Error('cron_heartbeats unreachable'))
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect((await res.json()).success).toBe(true)
  })
})
