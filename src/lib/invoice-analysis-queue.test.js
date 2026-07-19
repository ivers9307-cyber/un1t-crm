// QSTASH.6 — behaviour contract for the shared invoices_queue analysis
// processor. Per-row OCR/success/failure logic extracted from the
// process-invoice-analysis cron so the QStash worker route and the cron
// share ONE implementation and can run concurrently against the same
// table.
//
// Claim mechanism (worker side): a single conditional UPDATE that
// mirrors the `claim_invoice_analysis_batch` RPC's predicate exactly —
// status still 'quality_approved', analysis_queued_at still set, and
// analysis_claimed_at NULL or staler than the RPC's 10-minute window —
// stamping a fresh analysis_claimed_at. Exactly one claimant matches;
// the loser matches 0 rows and skips. The cron keeps the RPC for its
// batch claim (FOR UPDATE SKIP LOCKED matters when selecting N rows);
// by-id the plain CAS gives the same claim-exactly-once guarantee.
//
// Failure semantics (the INV-BULK.1 design, unchanged): an extraction
// failure records the error and DE-QUEUES the row (analysis_queued_at
// cleared) so a bad file is never retried forever — the operator retries
// manually from the UI. That is a *processed* outcome with an
// extractionError, NOT a retryable failure.
//
// Pure unit tests — no DB, no network. Supabase client + extraction are
// mocked.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/invoice-extraction', () => ({
  extractInvoiceFieldsFromBytes: vi.fn(),
  scoreExtractionConfidence: vi.fn(),
}))

import {
  claimAndProcessInvoiceAnalysisRow,
  processInvoiceAnalysisRow,
  CLAIM_STALE_MINUTES,
} from './invoice-analysis-queue.js'
import { extractInvoiceFieldsFromBytes, scoreExtractionConfidence } from '@/lib/invoice-extraction'

// ── db mock factory ───────────────────────────────────────────────────────────

/**
 * Chainable Supabase mock for the shapes this lib issues:
 *   claim   — update({analysis_claimed_at}).eq('id').eq('status')
 *               .not('analysis_queued_at','is',null).or(…).select('id')
 *   outcome — update({…}).eq('id')[.eq('status','quality_approved')] ← awaited
 *   storage — db.storage.from(bucket).download(path)
 * Builders are thenables (the repo invariant), so the mock is too.
 * Records every update payload + filter chain for assertions. The
 * success write (payload.status === 'extracted') can be made to error
 * via `successUpdateError`.
 */
function makeDb({
  claimData = [{ id: 'inv-1' }],
  successUpdateError = null,
  downloadResult = { data: makeBlob(), error: null },
} = {}) {
  const calls = { updates: [], downloads: [] }

  const fromMock = vi.fn(() => ({
    update: vi.fn((payload) => {
      const filters = []
      const record = { payload, filters }
      const builder = {
        eq: vi.fn((col, val) => {
          filters.push(['eq', col, val])
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
        // Outcome updates are awaited without a trailing .select().
        then(resolve, reject) {
          calls.updates.push(record)
          const error = payload.status === 'extracted' ? successUpdateError : null
          return Promise.resolve({ data: null, error }).then(resolve, reject)
        },
      }
      return builder
    }),
  }))

  const storage = {
    from: vi.fn((bucket) => ({
      download: vi.fn((path) => {
        calls.downloads.push([bucket, path])
        return Promise.resolve(downloadResult)
      }),
    })),
  }

  return { from: fromMock, storage, _calls: calls }
}

function makeBlob() {
  return { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }
}

const ROW = {
  id: 'inv-1',
  status: 'quality_approved',
  attachment_bucket: 'invoices',
  attachment_path: 'loc-1/invoice.pdf',
  attachment_mime_type: 'application/pdf',
  analysis_queued_at: '2026-07-19T10:00:00.000Z',
  analysis_claimed_at: null,
}

const FIELDS = { supplier_name: 'Acme', invoice_number: 'INV-9', total: 123.45 }

beforeEach(() => {
  vi.clearAllMocks()
  extractInvoiceFieldsFromBytes.mockResolvedValue({ ok: true, fields: FIELDS })
  scoreExtractionConfidence.mockReturnValue('high')
})

// ── exports ───────────────────────────────────────────────────────────────────

describe('exports', () => {
  it('exports the stale-claim window the RPC has always used (mig 220: 10 minutes)', () => {
    expect(CLAIM_STALE_MINUTES).toBe(10)
  })
})

// ── claimAndProcessInvoiceAnalysisRow ─────────────────────────────────────────

describe('claimAndProcessInvoiceAnalysisRow', () => {
  it('claims via a CAS mirroring the RPC predicate, then extracts', async () => {
    const db = makeDb()

    const result = await claimAndProcessInvoiceAnalysisRow(db, ROW)

    expect(result).toEqual({ status: 'processed' })
    const claim = db._calls.updates[0]
    expect(typeof claim.payload.analysis_claimed_at).toBe('string')
    expect(Object.keys(claim.payload)).toEqual(['analysis_claimed_at'])
    expect(claim.filters[0]).toEqual(['eq', 'id', 'inv-1'])
    expect(claim.filters[1]).toEqual(['eq', 'status', 'quality_approved'])
    expect(claim.filters[2]).toEqual(['not', 'analysis_queued_at', 'is', null])
    const [orTag, orExpr] = claim.filters[3]
    expect(orTag).toBe('or')
    expect(orExpr).toMatch(/^analysis_claimed_at\.is\.null,analysis_claimed_at\.lt\./)
    expect(claim.selected).toBe('id')
    expect(extractInvoiceFieldsFromBytes).toHaveBeenCalledTimes(1)
  })

  it('uses a stale-claim cutoff CLAIM_STALE_MINUTES in the past', async () => {
    const db = makeDb()
    const before = Date.now()

    await claimAndProcessInvoiceAnalysisRow(db, ROW)

    const orExpr = db._calls.updates[0].filters[3][1]
    const cutoffIso = orExpr.split('analysis_claimed_at.lt.')[1]
    const cutoff = new Date(cutoffIso).getTime()
    expect(cutoff).toBeGreaterThanOrEqual(before - CLAIM_STALE_MINUTES * 60_000 - 1000)
    expect(cutoff).toBeLessThanOrEqual(Date.now() - CLAIM_STALE_MINUTES * 60_000)
  })

  it('returns skipped without extracting when another claimant won the CAS', async () => {
    const db = makeDb({ claimData: [] })

    const result = await claimAndProcessInvoiceAnalysisRow(db, ROW)

    expect(result).toEqual({ status: 'skipped' })
    expect(extractInvoiceFieldsFromBytes).not.toHaveBeenCalled()
    expect(db._calls.updates).toHaveLength(1) // the losing claim only
  })

  it('returns skipped when the claim select resolves with null data', async () => {
    const db = makeDb({ claimData: null })

    const result = await claimAndProcessInvoiceAnalysisRow(db, ROW)

    expect(result).toEqual({ status: 'skipped' })
    expect(extractInvoiceFieldsFromBytes).not.toHaveBeenCalled()
  })
})

// ── processInvoiceAnalysisRow ─────────────────────────────────────────────────

describe('processInvoiceAnalysisRow', () => {
  it('does NOT claim — the first write is the outcome (cron rows are already RPC-claimed)', async () => {
    const db = makeDb()

    const result = await processInvoiceAnalysisRow(db, ROW)

    expect(result).toEqual({ status: 'processed' })
    expect(db._calls.updates).toHaveLength(1)
    expect(db._calls.updates[0].payload.status).toBe('extracted')
  })

  it('downloads the attachment from the row bucket/path and extracts with the row mime type', async () => {
    const db = makeDb()

    await processInvoiceAnalysisRow(db, ROW)

    expect(db._calls.downloads).toEqual([['invoices', 'loc-1/invoice.pdf']])
    const [bytes, mime] = extractInvoiceFieldsFromBytes.mock.calls[0]
    expect(Buffer.isBuffer(bytes)).toBe(true)
    expect(Array.from(bytes)).toEqual([1, 2, 3])
    expect(mime).toBe('application/pdf')
  })

  it('on success flips the row to extracted (status-guarded) with fields + confidence and clears the queue flags', async () => {
    const db = makeDb()

    const result = await processInvoiceAnalysisRow(db, ROW)

    expect(result).toEqual({ status: 'processed' })
    const write = db._calls.updates[0]
    expect(write.payload).toEqual({
      status: 'extracted',
      extracted_at: expect.any(String),
      extracted_fields: FIELDS,
      extraction_confidence: 'high',
      extraction_error: null,
      analysis_queued_at: null,
      analysis_claimed_at: null,
    })
    expect(scoreExtractionConfidence).toHaveBeenCalledWith(FIELDS)
    // Guard against a racing manual /extract or reject between claim and write.
    expect(write.filters).toEqual([
      ['eq', 'id', 'inv-1'],
      ['eq', 'status', 'quality_approved'],
    ])
  })

  it.each([
    ['missing path', { ...ROW, attachment_path: null }],
    ['missing bucket', { ...ROW, attachment_bucket: null }],
  ])('records no_attachment and de-queues when the row has no attachment (%s)', async (_label, row) => {
    const db = makeDb()

    const result = await processInvoiceAnalysisRow(db, row)

    expect(result).toEqual({ status: 'processed', extractionError: 'no_attachment' })
    expect(extractInvoiceFieldsFromBytes).not.toHaveBeenCalled()
    const write = db._calls.updates[0]
    expect(write.payload).toEqual({
      extraction_error: 'no_attachment',
      extracted_at: expect.any(String),
      analysis_queued_at: null, // de-queue — surface the error, don't loop
      analysis_claimed_at: null,
    })
    expect(write.filters).toEqual([['eq', 'id', 'inv-1']])
  })

  it('records the download error and de-queues when storage download fails', async () => {
    const db = makeDb({ downloadResult: { data: null, error: { message: 'object not found' } } })

    const result = await processInvoiceAnalysisRow(db, ROW)

    expect(result).toEqual({ status: 'processed', extractionError: 'download: object not found' })
    expect(extractInvoiceFieldsFromBytes).not.toHaveBeenCalled()
    expect(db._calls.updates[0].payload.extraction_error).toBe('download: object not found')
  })

  it('records download: unknown when storage returns neither blob nor error', async () => {
    const db = makeDb({ downloadResult: { data: null, error: null } })

    const result = await processInvoiceAnalysisRow(db, ROW)

    expect(result).toEqual({ status: 'processed', extractionError: 'download: unknown' })
  })

  it('records the extraction error and de-queues when OCR fails (deterministic — no retry loop)', async () => {
    const db = makeDb()
    extractInvoiceFieldsFromBytes.mockResolvedValue({ ok: false, error: 'unreadable scan' })

    const result = await processInvoiceAnalysisRow(db, ROW)

    expect(result).toEqual({ status: 'processed', extractionError: 'unreadable scan' })
    const write = db._calls.updates[0]
    expect(write.payload.extraction_error).toBe('unreadable scan')
    expect(write.payload.analysis_queued_at).toBeNull()
    expect(write.payload.analysis_claimed_at).toBeNull()
  })

  it('falls back to extraction_failed when the OCR failure carries no error string', async () => {
    const db = makeDb()
    extractInvoiceFieldsFromBytes.mockResolvedValue({ ok: false })

    const result = await processInvoiceAnalysisRow(db, ROW)

    expect(result).toEqual({ status: 'processed', extractionError: 'extraction_failed' })
  })

  it('records the update error and de-queues when the success write is refused (status raced)', async () => {
    const db = makeDb({ successUpdateError: { message: 'conflict' } })

    const result = await processInvoiceAnalysisRow(db, ROW)

    expect(result).toEqual({ status: 'processed', extractionError: 'conflict' })
    // success attempt first, then the de-queue error write
    expect(db._calls.updates).toHaveLength(2)
    expect(db._calls.updates[1].payload.extraction_error).toBe('conflict')
  })
})
