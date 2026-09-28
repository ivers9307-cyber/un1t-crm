// C21 PUSHDONE.1b — a challenge announcement is claimed (CAS on its
// announced_* column) before the send and RELEASED when the push reached
// nobody because something broke. It used to be stamped after the send
// whatever happened, with the stamp's own error discarded.
import { describe, it, expect, vi, beforeEach } from 'vitest'

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
      const isRelease = Object.values(state.patch).every((v) => v === null)
      if (isRelease) out = { data: null, error: releaseError }
      else out = claimError ? { data: null, error: claimError } : { data: claimMatches ? [{ id: state.eqs.id }] : [], error: null }
    } else if (table === 'challenges') out = { data: challengeRows, error: null }
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

const { GET } = await import('./route.js')
const { sendCustomerPush } = await import('@/lib/customer-push')
const { logWarn, logError } = await import('@/lib/log')

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
