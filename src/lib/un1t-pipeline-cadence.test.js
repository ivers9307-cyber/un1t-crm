// HATCHPIPE.2 — maybeReclassifyAfterSync: when a good un1t.online sync is
// followed by a board pass. Facts pinned:
//   1. no enabled un1t.online board → no_un1t_board, and the audit table is never read;
//   2. a pass finished inside the 55-minute gap → recent_run (54 min), outside it → runs (56 min);
//   3. the pass is source 'cron' for that location;
//   4. a failed pass does not hold the next tick off;
//   4b. a pass still RUNNING (no finished_at) that started under 10 minutes ago
//       → recent_run, so passes never stack behind one in flight; one started 10+
//       minutes ago is stuck and does not block;
//   5. anything throwing (reads or the reclassify) → { ran:false, reason:'error' }, logged, never thrown.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./pipeline-reclassify.js', () => ({ reclassifyAllContacts: vi.fn() }))
vi.mock('./log.js', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

import { maybeReclassifyAfterSync, RECLASSIFY_MIN_GAP_MS, RECLASSIFY_IN_FLIGHT_MS } from './un1t-pipeline-cadence.js'
import { reclassifyAllContacts } from './pipeline-reclassify.js'
import { logError } from './log.js'

const LOC = 'loc-hatch'
const NOW = Date.parse('2026-10-18T12:00:00Z')
const minAgo = (m) => new Date(NOW - m * 60_000).toISOString()

// Records each table read; a thenable chain resolves to the table's canned answer.
function fakeDb({ pipelines = [], runs = [], pipelinesError = null, runsError = null } = {}) {
  const reads = []
  const db = {
    from(table) {
      const answer = table === 'pipelines'
        ? { data: pipelinesError ? null : pipelines, error: pipelinesError }
        : { data: runsError ? null : runs, error: runsError }
      const chain = { table, calls: [] }
      reads.push(chain)
      const proxy = new Proxy({}, {
        get(_t, prop) {
          if (prop === 'then') return (res, rej) => Promise.resolve(answer).then(res, rej)
          return (...args) => { chain.calls.push([prop, args]); return proxy }
        },
      })
      return proxy
    },
  }
  return { db, reads }
}

const UN1T_BOARD = [{ id: 'p1', module: 'acquisition_un1t' }]

beforeEach(() => {
  vi.clearAllMocks()
  reclassifyAllContacts.mockResolvedValue({ ok: true, run_id: 'r1' })
})

describe('maybeReclassifyAfterSync', () => {
  it('exposes a 55-minute gap', () => {
    expect(RECLASSIFY_MIN_GAP_MS).toBe(55 * 60 * 1000)
  })

  it('no un1t board → no_un1t_board, no audit read', async () => {
    const { db, reads } = fakeDb({ pipelines: [{ id: 'p0', module: 'acquisition' }, { id: 'p9', module: 'unregistered_module' }] })
    expect(await maybeReclassifyAfterSync(db, LOC, { now: NOW })).toEqual({ ran: false, reason: 'no_un1t_board' })
    expect(reads.map((r) => r.table)).toEqual(['pipelines'])
    expect(reclassifyAllContacts).not.toHaveBeenCalled()
  })

  it('looks only at the location\'s ENABLED boards', async () => {
    const { db, reads } = fakeDb({ pipelines: [] })
    await maybeReclassifyAfterSync(db, LOC, { now: NOW })
    expect(reads[0].calls).toEqual(expect.arrayContaining([['eq', ['location_id', LOC]], ['eq', ['enabled', true]]]))
  })

  it('a run finished 54 min ago → recent_run', async () => {
    const { db, reads } = fakeDb({ pipelines: UN1T_BOARD, runs: [{ started_at: minAgo(55), finished_at: minAgo(54), status: 'success' }] })
    expect(await maybeReclassifyAfterSync(db, LOC, { now: NOW })).toEqual({ ran: false, reason: 'recent_run' })
    expect(reclassifyAllContacts).not.toHaveBeenCalled()
    // The newest run for THIS location, by started_at.
    expect(reads[1].table).toBe('pipeline_classification_runs')
    expect(reads[1].calls).toEqual(expect.arrayContaining([
      ['eq', ['location_id', LOC]], ['order', ['started_at', { ascending: false }]], ['limit', [1]],
    ]))
  })

  it('a run finished 56 min ago → runs with source cron', async () => {
    const { db } = fakeDb({ pipelines: UN1T_BOARD, runs: [{ started_at: minAgo(57), finished_at: minAgo(56), status: 'success' }] })
    const out = await maybeReclassifyAfterSync(db, LOC, { now: NOW })
    expect(out).toEqual({ ran: true, result: { ok: true, run_id: 'r1' } })
    expect(reclassifyAllContacts).toHaveBeenCalledTimes(1)
    expect(reclassifyAllContacts).toHaveBeenCalledWith(db, { locationId: LOC, source: 'cron' })
  })

  it('no run yet → runs', async () => {
    const { db } = fakeDb({ pipelines: UN1T_BOARD, runs: [] })
    expect((await maybeReclassifyAfterSync(db, LOC, { now: NOW })).ran).toBe(true)
  })

  it('a FAILED run 10 min ago does not hold the next tick off', async () => {
    const { db } = fakeDb({ pipelines: UN1T_BOARD, runs: [{ started_at: minAgo(11), finished_at: minAgo(10), status: 'failed' }] })
    expect((await maybeReclassifyAfterSync(db, LOC, { now: NOW })).ran).toBe(true)
  })

  it('exposes a 10-minute in-flight window', () => {
    expect(RECLASSIFY_IN_FLIGHT_MS).toBe(10 * 60 * 1000)
  })

  it('a pass still running, started 9 min ago → recent_run (never stack behind one in flight)', async () => {
    const { db } = fakeDb({ pipelines: UN1T_BOARD, runs: [{ started_at: minAgo(9), finished_at: null, status: 'running' }] })
    expect(await maybeReclassifyAfterSync(db, LOC, { now: NOW })).toEqual({ ran: false, reason: 'recent_run' })
    expect(reclassifyAllContacts).not.toHaveBeenCalled()
  })

  it('a pass still running, started 11 min ago, is stuck → runs', async () => {
    const { db } = fakeDb({ pipelines: UN1T_BOARD, runs: [{ started_at: minAgo(11), finished_at: null, status: 'running' }] })
    expect((await maybeReclassifyAfterSync(db, LOC, { now: NOW })).ran).toBe(true)
    expect(reclassifyAllContacts).toHaveBeenCalledTimes(1)
  })

  it('a running row with an unreadable started_at does not block', async () => {
    const { db } = fakeDb({ pipelines: UN1T_BOARD, runs: [{ started_at: null, finished_at: null, status: 'running' }] })
    expect((await maybeReclassifyAfterSync(db, LOC, { now: NOW })).ran).toBe(true)
  })

  it('a FAILED row with no finished_at, started 2 min ago, still never counts', async () => {
    const { db } = fakeDb({ pipelines: UN1T_BOARD, runs: [{ started_at: minAgo(2), finished_at: null, status: 'failed' }] })
    expect((await maybeReclassifyAfterSync(db, LOC, { now: NOW })).ran).toBe(true)
  })

  it('reclassify returning { ok:false } is still ran:true with that result (the audit row carries the cause)', async () => {
    reclassifyAllContacts.mockResolvedValue({ ok: false, error: 'un1t inputs unavailable: read_failed' })
    const { db } = fakeDb({ pipelines: UN1T_BOARD })
    expect(await maybeReclassifyAfterSync(db, LOC, { now: NOW })).toEqual({
      ran: true, result: { ok: false, error: 'un1t inputs unavailable: read_failed' },
    })
  })

  it('reclassify throwing → { ran:false, reason:"error" }, logged by name only', async () => {
    reclassifyAllContacts.mockRejectedValue(new Error('secret-token-abc'))
    const { db } = fakeDb({ pipelines: UN1T_BOARD })
    expect(await maybeReclassifyAfterSync(db, LOC, { now: NOW })).toEqual({ ran: false, reason: 'error' })
    expect(logError).toHaveBeenCalledWith('un1t-pipeline-cadence', 'reclassify after sync failed', {
      locationId: LOC, reason: 'error', errName: 'Error',
    })
    expect(JSON.stringify(logError.mock.calls)).not.toContain('secret-token')
  })

  it('an unreadable pipelines or audit table → error, never throws, never runs', async () => {
    const a = fakeDb({ pipelinesError: { message: 'boom' } })
    expect(await maybeReclassifyAfterSync(a.db, LOC, { now: NOW })).toEqual({ ran: false, reason: 'error' })
    const b = fakeDb({ pipelines: UN1T_BOARD, runsError: { message: 'boom' } })
    expect(await maybeReclassifyAfterSync(b.db, LOC, { now: NOW })).toEqual({ ran: false, reason: 'error' })
    expect(reclassifyAllContacts).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledTimes(2)
  })
})
