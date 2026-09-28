// C21 PUSHDONE.1b — a challenge announcement is claimed (CAS on its
// announced_* column) before the send and RELEASED when the push reached
// nobody because something broke. It used to be stamped after the send
// whatever happened, with the stamp's own error discarded.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const updates = []
let challengeRows = []
let tokenRows = []
let claimError = null
let claimMatches = true
let releaseError = null
function makeBuilder(table) {
  const state = { eqs: {}, is: {} }
  const b = {}
  for (const m of ['or', 'order', 'range']) b[m] = () => b
  b.select = () => { state.selected = true; return b }
  b.eq = (c, v) => { state.eqs[c] = v; return b }
  b.is = (c, v) => { state.is[c] = v; return b }
  b.update = (patch) => { state.patch = patch; updates.push({ table, patch, eqs: state.eqs, is: state.is }); return b }
  b.then = (res, rej) => {
    let out
    if (state.patch) {
      // The claim and the release act on the stored row, so a second run sees
      // what the first one left (announced exactly once across runs).
      const [column, value] = Object.entries(state.patch)[0]
      const row = challengeRows.find((r) => r.id === state.eqs.id)
      if (value === null) {
        if (!releaseError && row && row[column] === state.eqs[column]) row[column] = null
        out = { data: null, error: releaseError }
      } else if (claimError) out = { data: null, error: claimError }
      else {
        const won = claimMatches && (!row || row[column] == null)
        if (won && row) row[column] = value
        out = { data: won ? [{ id: state.eqs.id }] : [], error: null }
      }
    } else if (table === 'challenges') out = { data: challengeRows.map((r) => ({ ...r })), error: null }
    else if (table === 'champ_push_tokens') out = { data: tokenRows, error: null }
    else out = { data: [], error: null }
    return Promise.resolve(out).then(res, rej)
  }
  return b
}
const fakeDb = { from: (t) => makeBuilder(t) }

vi.mock('@/lib/supabase', () => ({ createServerClient: () => fakeDb }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/customer-push', () => ({ sendCustomerPush: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/challenges-io', () => ({ computeStandings: vi.fn(async () => []), computeCollective: vi.fn(async () => ({ total: 0, target: 10, pct: 0 })) }))

const { GET, END_ANNOUNCE_RETRY_DAYS } = await import('./route.js')
const { sendCustomerPush } = await import('@/lib/customer-push')
const { logWarn, logError } = await import('@/lib/log')
const { computeStandings } = await import('@/lib/challenges-io')

const req = () => ({ headers: { get: (k) => (k.toLowerCase() === 'authorization' ? 'Bearer test-secret' : null) } })
const today = () => new Date().toISOString().slice(0, 10)
const START = () => ({ id: 'ch-1', location_id: 'loc-1', name: 'October points', mode: 'individual', metric: 'points', starts_on: today(), ends_on: '2099-01-01', target: null, announced_start_at: null, announced_end_at: null, announced_target_at: null })
const claimOf = (u) => u.patch.announced_start_at && u.is.announced_start_at === null
const releaseOf = (u) => u.patch.announced_start_at === null

beforeEach(() => {
  process.env.CRON_SECRET = 'test-secret'
  vi.clearAllMocks()
  updates.length = 0
  challengeRows = [START()]
  tokenRows = [{ contact_id: 'm1' }, { contact_id: 'm2' }]
  claimError = null
  claimMatches = true
  releaseError = null
  sendCustomerPush.mockResolvedValue({ sent: 2, invalidated: 0, failed: 0, skipped: 0 })
})

describe('run-challenge-events — claim, send, release on failure (C21 PUSHDONE.1b)', () => {
  it('claims with a CAS BEFORE sending, keeps it on delivery', async () => {
    let claimedBeforeSend = null
    sendCustomerPush.mockImplementationOnce(async () => { claimedBeforeSend = updates.some(claimOf); return { sent: 2, failed: 0 } })
    const body = await (await GET(req())).json()
    expect(claimedBeforeSend).toBe(true)
    expect(updates.find(claimOf).eqs).toEqual({ id: 'ch-1' })
    expect(updates.some(releaseOf)).toBe(false)
    expect(body).toMatchObject({ ok: true, started: 1, failed: 0 })
  })

  it('a broadcast that reached nobody because it FAILED gives the claim back', async () => {
    sendCustomerPush.mockResolvedValueOnce({ sent: 0, invalidated: 0, failed: 2, skipped: 0, read_failed: 1 })
    const body = await (await GET(req())).json()
    const release = updates.find(releaseOf)
    expect(release.eqs).toMatchObject({ id: 'ch-1' })
    expect(release.eqs.announced_start_at).toEqual(updates.find(claimOf).patch.announced_start_at)
    expect(body).toMatchObject({ started: 0, failed: 1 })
    expect(logWarn).toHaveBeenCalledWith('cron-challenge-events', 'announcement reached nobody; claim released, the next run retries',
      { id: 'ch-1', column: 'announced_start_at', read_failed: true })
  })

  it('a partial broadcast keeps the claim: never re-announced to members who have it', async () => {
    sendCustomerPush.mockResolvedValueOnce({ sent: 1, invalidated: 0, failed: 1, skipped: 0 })
    await GET(req())
    expect(updates.some(releaseOf)).toBe(false)
  })

  it('a partial broadcast says how many sends failed (a count, no member ids)', async () => {
    sendCustomerPush.mockResolvedValueOnce({ sent: 1, invalidated: 0, failed: 3, skipped: 0 })
    const body = await (await GET(req())).json()
    expect(body).toMatchObject({ started: 1, failed: 0 })
    expect(logWarn).toHaveBeenCalledWith('cron-challenge-events', 'announcement delivered to some members; failed sends are not retried',
      { id: 'ch-1', column: 'announced_start_at', failed: 3 })
  })

  it('a clean broadcast warns nothing', async () => {
    await GET(req())
    expect(logWarn).not.toHaveBeenCalled()
  })

  it('an announcement another run already claimed is not sent', async () => {
    claimMatches = false
    const body = await (await GET(req())).json()
    expect(sendCustomerPush).not.toHaveBeenCalled()
    expect(body).toMatchObject({ started: 0, failed: 0 })
  })

  it('a failed claim sends nothing and says so', async () => {
    claimError = { message: 'down' }
    const body = await (await GET(req())).json()
    expect(sendCustomerPush).not.toHaveBeenCalled()
    expect(body.failed).toBe(1)
    expect(logWarn).toHaveBeenCalledWith('cron-challenge-events', 'announcement claim failed; nothing sent, the next run retries',
      { id: 'ch-1', column: 'announced_start_at', err: 'down' })
  })

  it('no app-linked members: claimed and counted, nothing sent', async () => {
    tokenRows = []
    const body = await (await GET(req())).json()
    expect(sendCustomerPush).not.toHaveBeenCalled()
    expect(updates.some(claimOf)).toBe(true)
    expect(body.started).toBe(1)
  })

  it('a failed release is said at error level', async () => {
    releaseError = { message: 'down' }
    sendCustomerPush.mockResolvedValueOnce({ sent: 0, failed: 2 })
    await GET(req())
    expect(logError).toHaveBeenCalledWith('cron-challenge-events', 'announcement reached nobody and the claim release failed; it will not be sent',
      { id: 'ch-1', column: 'announced_start_at', err: 'down' })
  })
})

// PUSHDONE.1b review — a released END used to be retried every day for ever
// (`ends_on < today` stays true), so a persistent push failure could reach
// members weeks after the challenge ended. It is retried for
// END_ANNOUNCE_RETRY_DAYS (Dublin dates), then stamped unsent with a logError.
describe('run-challenge-events — the END retry is bounded (C21 PUSHDONE.1b)', () => {
  const NOW = '2026-10-15T08:00:00.000Z' // the 08:00 UTC cron; Dublin date 2026-10-15
  const END = (ends_on) => ({ id: 'ch-end', location_id: 'loc-1', name: 'October points', mode: 'individual', metric: 'points', starts_on: '2026-10-01', ends_on, target: null, announced_start_at: '2026-10-01T08:00:00.000Z', announced_end_at: null, announced_target_at: null })
  const endClaimOf = (u) => u.patch.announced_end_at && u.is.announced_end_at === null

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(NOW))
  })
  afterEach(() => { vi.useRealTimers() })

  it('the window is two days', () => {
    expect(END_ANNOUNCE_RETRY_DAYS).toBe(2)
  })

  it('an END still inside the window is retried after a failure, then announced exactly once', async () => {
    challengeRows = [END('2026-10-13')] // today - 2: the last day it may go out
    sendCustomerPush.mockResolvedValueOnce({ sent: 0, invalidated: 0, failed: 2, skipped: 0 })
    const first = await (await GET(req())).json()
    expect(first).toMatchObject({ ended: 0, failed: 1, gave_up: 0 })
    expect(challengeRows[0].announced_end_at).toBeNull()

    const second = await (await GET(req())).json()
    expect(second).toMatchObject({ ended: 1, failed: 0, gave_up: 0 })
    expect(challengeRows[0].announced_end_at).toBe(NOW)

    const third = await (await GET(req())).json()
    expect(third).toMatchObject({ ended: 0, failed: 0, gave_up: 0 })
    expect(sendCustomerPush).toHaveBeenCalledTimes(2)
    expect(logError).not.toHaveBeenCalled()
  })

  it('an END past the window is stamped WITHOUT a send, at error level, once', async () => {
    challengeRows = [END('2026-10-12')] // today - 3
    const first = await (await GET(req())).json()
    expect(sendCustomerPush).not.toHaveBeenCalled()
    expect(computeStandings).not.toHaveBeenCalled()
    expect(updates.find(endClaimOf).eqs).toEqual({ id: 'ch-end' })
    expect(challengeRows[0].announced_end_at).toBe(NOW)
    expect(first).toMatchObject({ ended: 0, failed: 0, gave_up: 1 })
    expect(logError).toHaveBeenCalledWith('cron-challenge-events', 'end announcement not sent within its retry window; gave up',
      { challengeId: 'ch-end' })

    const second = await (await GET(req())).json()
    expect(second).toMatchObject({ gave_up: 0 })
    expect(sendCustomerPush).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledTimes(1)
  })

  it('a failed give-up stamp is said and counted; the next run tries again', async () => {
    challengeRows = [END('2026-09-01')]
    claimError = { message: 'down' }
    const body = await (await GET(req())).json()
    expect(sendCustomerPush).not.toHaveBeenCalled()
    expect(body).toMatchObject({ failed: 1, gave_up: 0 })
    expect(logError).not.toHaveBeenCalled()
    expect(logWarn).toHaveBeenCalledWith('cron-challenge-events', 'end announcement is past its retry window and the give-up stamp failed; the next run tries again',
      { challengeId: 'ch-end', err: 'down' })
  })
})
