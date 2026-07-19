// QSTASH.10 — behaviour contract for the shared receipt-hunt claim
// wrapper (worker side).
//
// The per-row unit itself is huntLine (hunt.js) — it was ALREADY shared
// (the process-receipt-hunts cron calls it directly on RPC-claimed
// rows), so unlike QSTASH.6 nothing needed extracting; this lib only
// adds the worker's by-id claim.
//
// Claim mechanism: a single conditional UPDATE that mirrors the
// `claim_recon_hunt_batch` RPC's predicate exactly (mig 370) — status
// still in ('uncovered','not_found'), hunt_queued_at still set, and
// hunt_claimed_at NULL or staler than the RPC's 10-minute window —
// stamping a fresh hunt_claimed_at. Exactly one claimant matches; the
// loser matches 0 rows and skips. The cron keeps the RPC for its batch
// claim (FOR UPDATE SKIP LOCKED matters when selecting N rows); by-id
// the plain CAS gives the same claim-exactly-once guarantee (the
// QSTASH.6 equivalence argument).
//
// Pure unit tests — no DB, no IMAP, no LLM. huntLine is mocked.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./hunt', () => ({
  huntLine: vi.fn(),
}))

import { claimAndHuntLine, CLAIM_STALE_MINUTES } from './hunt-queue.js'
import { huntLine } from './hunt'

// ── db mock factory ───────────────────────────────────────────────────────────

/**
 * Chainable Supabase mock for the single shape this lib issues:
 *   claim — update({hunt_claimed_at}).eq('id').in('status', […])
 *             .not('hunt_queued_at','is',null).or(…).select('id')
 * Records the update payload + filter chain for assertions.
 */
function makeDb({ claimData = [{ id: 'line-1' }] } = {}) {
  const calls = { updates: [] }

  const fromMock = vi.fn(() => ({
    update: vi.fn((payload) => {
      const filters = []
      const record = { payload, filters }
      const builder = {
        eq: vi.fn((col, val) => {
          filters.push(['eq', col, val])
          return builder
        }),
        in: vi.fn((col, vals) => {
          filters.push(['in', col, vals])
          return builder
        }),
        not: vi.fn((col, op, val) => {
          filters.push(['not', col, op, val])
          return builder
        }),
        or: vi.fn((expr) => {
          filters.push(['or', expr])
          return builder
        }),
        select: vi.fn((cols) => {
          record.selected = cols
          calls.updates.push(record)
          return Promise.resolve({ data: claimData })
        }),
      }
      return builder
    }),
  }))

  return { from: fromMock, _calls: calls }
}

const LINE = {
  id: 'line-1',
  location_id: 'loc-1',
  status: 'uncovered',
  line_date: '2026-07-10',
  description: 'AMAZON EU',
  amount: -42.5,
  hunt_queued_at: '2026-07-17T07:05:00.000Z',
  hunt_claimed_at: null,
  hunt_attempts: 0,
}

beforeEach(() => {
  vi.clearAllMocks()
  huntLine.mockResolvedValue({ outcome: 'not_found', examined: 2 })
})

// ── exports ───────────────────────────────────────────────────────────────────

describe('exports', () => {
  it('exports the stale-claim window the RPC has always used (mig 370: 10 minutes)', () => {
    expect(CLAIM_STALE_MINUTES).toBe(10)
  })
})

// ── claimAndHuntLine ──────────────────────────────────────────────────────────

describe('claimAndHuntLine', () => {
  it('claims via a CAS mirroring the claim_recon_hunt_batch predicate, then hunts', async () => {
    const db = makeDb()

    const result = await claimAndHuntLine(db, LINE)

    expect(result).toEqual({ status: 'hunted', outcome: 'not_found', examined: 2 })
    const claim = db._calls.updates[0]
    expect(typeof claim.payload.hunt_claimed_at).toBe('string')
    expect(Object.keys(claim.payload)).toEqual(['hunt_claimed_at'])
    expect(claim.filters[0]).toEqual(['eq', 'id', 'line-1'])
    expect(claim.filters[1]).toEqual(['in', 'status', ['uncovered', 'not_found']])
    expect(claim.filters[2]).toEqual(['not', 'hunt_queued_at', 'is', null])
    const [orTag, orExpr] = claim.filters[3]
    expect(orTag).toBe('or')
    expect(orExpr).toMatch(/^hunt_claimed_at\.is\.null,hunt_claimed_at\.lt\./)
    expect(claim.selected).toBe('id')
    expect(huntLine).toHaveBeenCalledTimes(1)
    expect(huntLine).toHaveBeenCalledWith(db, LINE)
  })

  it('uses a stale-claim cutoff CLAIM_STALE_MINUTES in the past', async () => {
    const db = makeDb()
    const before = Date.now()

    await claimAndHuntLine(db, LINE)

    const orExpr = db._calls.updates[0].filters[3][1]
    const cutoffIso = orExpr.split('hunt_claimed_at.lt.')[1]
    const cutoff = new Date(cutoffIso).getTime()
    expect(cutoff).toBeGreaterThanOrEqual(before - CLAIM_STALE_MINUTES * 60_000 - 1000)
    expect(cutoff).toBeLessThanOrEqual(Date.now() - CLAIM_STALE_MINUTES * 60_000)
  })

  it('returns skipped without hunting when another claimant won the CAS', async () => {
    const db = makeDb({ claimData: [] })

    const result = await claimAndHuntLine(db, LINE)

    expect(result).toEqual({ status: 'skipped' })
    expect(huntLine).not.toHaveBeenCalled()
    expect(db._calls.updates).toHaveLength(1) // the losing claim only
  })

  it('returns skipped when the claim select resolves with null data', async () => {
    const db = makeDb({ claimData: null })

    const result = await claimAndHuntLine(db, LINE)

    expect(result).toEqual({ status: 'skipped' })
    expect(huntLine).not.toHaveBeenCalled()
  })

  it("passes huntLine's error outcome through as a hunted result (terminal — huntLine already ran errorFinish)", async () => {
    const db = makeDb()
    huntLine.mockResolvedValue({ outcome: 'error', reason: 'budget' })

    const result = await claimAndHuntLine(db, LINE)

    expect(result).toEqual({ status: 'hunted', outcome: 'error', reason: 'budget' })
  })

  it('passes a found outcome through with its extras', async () => {
    const db = makeDb()
    huntLine.mockResolvedValue({ outcome: 'found', deduped: false, queueId: 'q-1' })

    const result = await claimAndHuntLine(db, LINE)

    expect(result).toEqual({ status: 'hunted', outcome: 'found', deduped: false, queueId: 'q-1' })
  })
})
