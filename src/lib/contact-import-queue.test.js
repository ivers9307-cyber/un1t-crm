// QSTASH.4 — behaviour contract for the shared contact_imports job
// processor. Claim/process/stamp semantics extracted from the
// process-contact-imports cron so the QStash worker route and the cron
// share ONE implementation and can run concurrently against the same
// table.
//
// Claim mechanism: flip status 'pending'→'processing' (+ fresh
// started_processing_at), conditioned on status still being 'pending' —
// the same status CAS the cron has always used, now keyed by id.
// Exactly one claimant matches; the loser matches 0 rows and skips.
// There is NO release-on-failure: a failed import stamps 'failed' +
// error_message for the operator (imports are not blindly retryable —
// part of the batch may already be written). A consumer that crashes
// mid-run leaves the row 'processing' for the cron's stuck-recovery
// pass (cron-only).
//
// Pure unit tests — no DB. Supabase client + import runner are mocked.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/contact-import-runner', async (importOriginal) => ({
  ...(await importOriginal()),
  runImportCommit: vi.fn(),
}))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { claimAndProcessImportJob, STUCK_AFTER_MINUTES } from './contact-import-queue.js'
import { runImportCommit, isLedgerIncomplete } from '@/lib/contact-import-runner'
import { logError } from '@/lib/log'

// ── db mock factory ───────────────────────────────────────────────────────────

/**
 * Chainable Supabase mock for the two update shapes this lib issues:
 *   claim  — update({status:'processing',…}).eq('id').eq('status','pending').select('id')
 *   stamps — update({status:'completed'|'failed',…}).eq('id')  ← awaited directly
 * Builders are thenables (the repo invariant), so the mock is too.
 * Records every update payload + filter chain for assertions.
 */
function makeDb({ claimData = [{ id: 'imp-1' }] } = {}) {
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
        select: vi.fn((cols) => {
          record.selected = cols
          calls.updates.push(record)
          return Promise.resolve({ data: claimData })
        }),
        // Stamp updates are awaited without a trailing .select().
        then(resolve, reject) {
          calls.updates.push(record)
          return Promise.resolve({ data: null, error: null }).then(resolve, reject)
        },
      }
      return builder
    }),
  }))

  return { from: fromMock, _calls: calls }
}

const JOB = {
  id: 'imp-1',
  location_id: 'loc-1',
  status: 'pending',
  payload: {
    mapping: { Email: 'email' },
    rows: [{ Email: 'a@b.ie' }],
    batchTag: 'july-batch',
    resolutions: { 'a@b.ie': 'row_wins' },
  },
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ── exports ───────────────────────────────────────────────────────────────────

describe('exports', () => {
  it('exports the stuck-recovery threshold the cron has always used', () => {
    expect(STUCK_AFTER_MINUTES).toBe(5)
  })
})

// ── claimAndProcessImportJob ──────────────────────────────────────────────────

describe('claimAndProcessImportJob', () => {
  it('claims via CAS on id + pending status, then runs the import', async () => {
    const db = makeDb()
    runImportCommit.mockResolvedValue({ counts: { created: 3, updated: 1, skipped: 0, errored: 2 } })

    const result = await claimAndProcessImportJob(db, JOB)

    expect(result).toEqual({ status: 'processed' })
    const claim = db._calls.updates[0]
    expect(claim.payload.status).toBe('processing')
    expect(typeof claim.payload.started_processing_at).toBe('string')
    expect(claim.filters).toEqual([
      ['eq', 'id', 'imp-1'],
      ['eq', 'status', 'pending'],
    ])
    expect(claim.selected).toBe('id')
    expect(runImportCommit).toHaveBeenCalledWith(db, {
      importId: 'imp-1',
      locationId: 'loc-1',
      mapping: JOB.payload.mapping,
      rows: JOB.payload.rows,
      batchTag: 'july-batch',
      resolutions: JOB.payload.resolutions,
    })
  })

  it('stamps completed with the run counts and drops the payload', async () => {
    const db = makeDb()
    runImportCommit.mockResolvedValue({ counts: { created: 3, updated: 1, skipped: 0, errored: 2 } })

    await claimAndProcessImportJob(db, JOB)

    expect(db._calls.updates).toHaveLength(2)
    const stamp = db._calls.updates[1]
    expect(stamp.payload).toEqual({
      status: 'completed',
      created_count: 3,
      updated_count: 1,
      skipped_count: 0,
      errored_count: 2,
      payload: null,
    })
    expect(stamp.filters).toEqual([['eq', 'id', 'imp-1']])
  })

  it('returns skipped without running when another claimant won the CAS', async () => {
    const db = makeDb({ claimData: [] })

    const result = await claimAndProcessImportJob(db, JOB)

    expect(result).toEqual({ status: 'skipped' })
    expect(runImportCommit).not.toHaveBeenCalled()
    expect(db._calls.updates).toHaveLength(1) // the losing claim only
  })

  it('returns skipped when the claim select resolves with null data', async () => {
    const db = makeDb({ claimData: null })

    const result = await claimAndProcessImportJob(db, JOB)

    expect(result).toEqual({ status: 'skipped' })
    expect(runImportCommit).not.toHaveBeenCalled()
  })

  it('fails loudly (missingPayload flagged) when a pending job has no payload', async () => {
    const db = makeDb()

    const result = await claimAndProcessImportJob(db, { ...JOB, payload: null })

    expect(result).toEqual({
      status: 'failed',
      error: 'Job missing payload',
      missingPayload: true,
    })
    expect(runImportCommit).not.toHaveBeenCalled()
    const stamp = db._calls.updates[1]
    expect(stamp.payload).toEqual({
      status: 'failed',
      error_message: 'Pending job had no payload.',
    })
    expect(stamp.filters).toEqual([['eq', 'id', 'imp-1']])
  })

  it('stamps failed with the error message when the run throws', async () => {
    const db = makeDb()
    runImportCommit.mockRejectedValue(new Error('kaboom'))

    const result = await claimAndProcessImportJob(db, JOB)

    expect(result).toEqual({ status: 'failed', error: 'kaboom' })
    const stamp = db._calls.updates[1]
    expect(stamp.payload).toEqual({ status: 'failed', error_message: 'kaboom' })
  })

  it('stringifies non-Error throws', async () => {
    const db = makeDb()
    runImportCommit.mockRejectedValue('string blew up')

    const result = await claimAndProcessImportJob(db, JOB)

    expect(result).toEqual({ status: 'failed', error: 'string blew up' })
  })

  it('truncates the stamped error message to 2000 chars', async () => {
    const db = makeDb()
    runImportCommit.mockRejectedValue(new Error('x'.repeat(3000)))

    const result = await claimAndProcessImportJob(db, JOB)

    expect(result.status).toBe('failed')
    expect(result.error).toHaveLength(2000)
    expect(db._calls.updates[1].payload.error_message).toHaveLength(2000)
  })

  // IMPORTLEDGER.1 (audit A08) — a lost ledger chunk loses before_snapshots,
  // so the import must not look fully recoverable.
  it('a lost ledger chunk cannot produce an apparently fully recoverable completed import', async () => {
    const db = makeDb()
    runImportCommit.mockResolvedValue({ counts: { created: 3, updated: 500, skipped: 0, errored: 0 }, ledgerFailed: 500 })

    const result = await claimAndProcessImportJob(db, JOB)

    expect(result).toEqual({ status: 'processed', ledgerIncomplete: true })
    const stamp = db._calls.updates[1]
    expect(stamp.payload.status).toBe('completed')
    // The payload is KEPT: it is the only record left of the lost rows.
    expect('payload' in stamp.payload).toBe(false)
    // The batch carries the marker the detail page and the rollback route read.
    expect(isLedgerIncomplete({ error_message: stamp.payload.error_message })).toBe(true)
    expect(stamp.payload.error_message).toContain('500')
    expect(logError).toHaveBeenCalled()
    expect(JSON.stringify(logError.mock.calls.at(-1)[2])).toContain('imp-1')
  })

  it('a clean run carries no ledger marker', async () => {
    const db = makeDb()
    runImportCommit.mockResolvedValue({ counts: { created: 1, updated: 0, skipped: 0, errored: 0 }, ledgerFailed: 0 })

    await claimAndProcessImportJob(db, JOB)

    expect(db._calls.updates[1].payload.error_message).toBeUndefined()
    expect(db._calls.updates[1].payload.payload).toBeNull()
  })
})
