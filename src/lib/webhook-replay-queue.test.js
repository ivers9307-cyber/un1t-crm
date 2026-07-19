// QSTASH.3 — behaviour contract for the shared webhook_dead_letter row
// processor. Claim/process/release semantics extracted from the replay
// cron so the QStash worker route and the cron share ONE implementation
// and can run concurrently against the same table.
//
// Claim mechanism: webhook_dead_letter has no 'replaying' status (check
// constraint: pending/resolved/failed/discarded — mig 315), so the CAS
// flips last_attempt_at forward ONLY where it still equals the value the
// caller read (IS NULL for never-attempted rows). Exactly one claimant
// matches; the loser matches 0 rows and skips.
//
// Pure unit tests — no DB. Supabase client + replay driver are mocked.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/webhook-replay', () => ({
  isReplayable: vi.fn((p) => p === 'inbody' || p === 'postmark'),
  replayDeadLetter: vi.fn(),
  REPLAYABLE_PROVIDERS: ['inbody', 'postmark'],
}))

import {
  claimAndReplayDeadLetterRow,
  MAX_ATTEMPTS,
  REPLAYABLE_PROVIDERS,
} from './webhook-replay-queue.js'
import { replayDeadLetter } from '@/lib/webhook-replay'

// ── db mock factory ───────────────────────────────────────────────────────────

/**
 * Chainable Supabase mock for the claim CAS this lib issues:
 *   update({last_attempt_at}).eq('id').eq('status','pending')
 *     .eq|is('last_attempt_at', <read value>).select('id')
 * Records the update payload and the filter chain for assertions.
 */
function makeDb({ claimData = [{ id: 7 }] } = {}) {
  const calls = { claims: [] }

  const fromMock = vi.fn(() => ({
    update: vi.fn((payload) => {
      const filters = []
      const builder = {
        eq: vi.fn((col, val) => {
          filters.push(['eq', col, val])
          return builder
        }),
        is: vi.fn((col, val) => {
          filters.push(['is', col, val])
          return builder
        }),
        select: vi.fn(() => {
          calls.claims.push({ payload, filters: [...filters] })
          return Promise.resolve({ data: claimData })
        }),
      }
      return builder
    }),
  }))

  return { from: fromMock, _calls: calls }
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ── exports ───────────────────────────────────────────────────────────────────

describe('exports', () => {
  it('exports the replay retry budget the cron has always used', () => {
    expect(MAX_ATTEMPTS).toBe(5)
  })

  it('re-exports the replayable provider list (glofox stays excluded)', () => {
    expect(REPLAYABLE_PROVIDERS).toEqual(['inbody', 'postmark'])
  })
})

// ── claimAndReplayDeadLetterRow ───────────────────────────────────────────────

describe('claimAndReplayDeadLetterRow', () => {
  const attemptedRow = {
    id: 7,
    provider: 'inbody',
    payload: { Account: 'test' },
    status: 'pending',
    attempts: 1,
    last_attempt_at: '2026-07-18T10:00:00.123+00:00',
  }

  it('claims via CAS on id + pending status + unchanged last_attempt_at, then processes', async () => {
    const db = makeDb()
    replayDeadLetter.mockResolvedValue({ ok: true, status: 'resolved' })

    const result = await claimAndReplayDeadLetterRow(db, attemptedRow)

    expect(result).toEqual({ status: 'processed' })
    expect(db._calls.claims).toHaveLength(1)
    const claim = db._calls.claims[0]
    expect(typeof claim.payload.last_attempt_at).toBe('string')
    expect(claim.filters).toEqual([
      ['eq', 'id', 7],
      ['eq', 'status', 'pending'],
      ['eq', 'last_attempt_at', '2026-07-18T10:00:00.123+00:00'],
    ])
    expect(replayDeadLetter).toHaveBeenCalledWith(db, attemptedRow, { maxAttempts: MAX_ATTEMPTS })
  })

  it('claims never-attempted rows with an IS NULL filter on last_attempt_at', async () => {
    const db = makeDb()
    replayDeadLetter.mockResolvedValue({ ok: true, status: 'resolved' })

    await claimAndReplayDeadLetterRow(db, { ...attemptedRow, last_attempt_at: null })

    expect(db._calls.claims[0].filters).toEqual([
      ['eq', 'id', 7],
      ['eq', 'status', 'pending'],
      ['is', 'last_attempt_at', null],
    ])
  })

  it('returns skipped without processing when another claimant won the CAS', async () => {
    const db = makeDb({ claimData: [] })

    const result = await claimAndReplayDeadLetterRow(db, attemptedRow)

    expect(result).toEqual({ status: 'skipped' })
    expect(replayDeadLetter).not.toHaveBeenCalled()
  })

  it('returns skipped when the claim select resolves with null data', async () => {
    const db = makeDb({ claimData: null })

    const result = await claimAndReplayDeadLetterRow(db, attemptedRow)

    expect(result).toEqual({ status: 'skipped' })
    expect(replayDeadLetter).not.toHaveBeenCalled()
  })

  it('returns skipped for a non-replayable provider without touching the row', async () => {
    const db = makeDb()

    const result = await claimAndReplayDeadLetterRow(db, { ...attemptedRow, provider: 'glofox' })

    expect(result).toEqual({ status: 'skipped' })
    expect(db.from).not.toHaveBeenCalled()
    expect(replayDeadLetter).not.toHaveBeenCalled()
  })

  it('returns failed with the replay error when the replay does not resolve the row', async () => {
    const db = makeDb()
    replayDeadLetter.mockResolvedValue({ ok: false, status: 'pending', error: 'kaboom' })

    const result = await claimAndReplayDeadLetterRow(db, attemptedRow)

    expect(result).toEqual({ status: 'failed', error: 'kaboom' })
  })

  it('defaults a missing replay error to unknown', async () => {
    const db = makeDb()
    replayDeadLetter.mockResolvedValue({ ok: false, status: 'failed' })

    const result = await claimAndReplayDeadLetterRow(db, attemptedRow)

    expect(result).toEqual({ status: 'failed', error: 'unknown' })
  })
})
