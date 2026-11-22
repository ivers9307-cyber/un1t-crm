// The analysis queue's job: claim a row exactly once, hand it to
// prepareInvoiceRow, and map the outcome to the shape the worker and the
// cron report. Reading and checking the invoice is prepare.test.js's job,
// so prepareInvoiceRow is mocked here.
//
// Claim: one conditional UPDATE mirroring claim_invoice_analysis_batch
// (status received or quality_approved, analysis_queued_at set,
// analysis_claimed_at null or older than CLAIM_STALE_MINUTES). Exactly one
// claimant matches; the loser sees 0 rows and skips.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../tests/helpers/fake-db.js'

vi.mock('@/lib/invoices-queue/prepare', () => ({ prepareInvoiceRow: vi.fn() }))
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))

import {
  claimAndProcessInvoiceAnalysisRow,
  processInvoiceAnalysisRow,
  CLAIM_STALE_MINUTES,
} from './invoice-analysis-queue.js'
import { prepareInvoiceRow } from '@/lib/invoices-queue/prepare'
import { logError } from '@/lib/log'

const LOC = '00000000-0000-4000-8000-000000000001'
const ID = '00000000-0000-4000-8000-0000000000a1'
const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString()

const dbRow = (extra = {}) => ({
  id: ID, location_id: LOC, status: 'received', attachment_bucket: 'invoices',
  attachment_path: 'loc/invoice.pdf', attachment_mime_type: 'application/pdf',
  analysis_queued_at: minutesAgo(1), analysis_claimed_at: null, ...extra,
})
const seed = (extra) => createFakeDb({ tables: { invoices_queue: [dbRow(extra)] } })
const stored = (db) => db.tables.invoices_queue[0]

beforeEach(() => {
  vi.clearAllMocks()
  prepareInvoiceRow.mockResolvedValue({ outcome: 'prepared', reasons: [] })
})

describe('exports', () => {
  it('exports the stale-claim window the RPC has always used (10 minutes)', () => {
    expect(CLAIM_STALE_MINUTES).toBe(10)
  })
})

describe('claimAndProcessInvoiceAnalysisRow', () => {
  it.each(['received', 'quality_approved'])('claims a queued %s row and prepares it', async (status) => {
    const db = seed({ status })
    const row = stored(db)
    const result = await claimAndProcessInvoiceAnalysisRow(db, { ...row })
    expect(result).toEqual({ status: 'processed' })
    expect(prepareInvoiceRow).toHaveBeenCalledTimes(1)
    expect(prepareInvoiceRow.mock.calls[0][1].id).toBe(ID)
    expect(stored(db).analysis_claimed_at).toEqual(expect.any(String))
  })

  it('does not claim a row in any other status', async () => {
    const db = seed({ status: 'extracted' })
    const result = await claimAndProcessInvoiceAnalysisRow(db, { ...stored(db) })
    expect(result).toEqual({ status: 'skipped' })
    expect(prepareInvoiceRow).not.toHaveBeenCalled()
  })

  it('does not claim a row that is not queued', async () => {
    const db = seed({ analysis_queued_at: null })
    const result = await claimAndProcessInvoiceAnalysisRow(db, { ...stored(db) })
    expect(result).toEqual({ status: 'skipped' })
    expect(prepareInvoiceRow).not.toHaveBeenCalled()
  })

  it('skips a row with a fresh claim without preparing it', async () => {
    const db = seed({ analysis_claimed_at: minutesAgo(1) })
    const result = await claimAndProcessInvoiceAnalysisRow(db, { ...stored(db) })
    expect(result).toEqual({ status: 'skipped' })
    expect(prepareInvoiceRow).not.toHaveBeenCalled()
  })

  it('re-claims a stale claim (older than CLAIM_STALE_MINUTES)', async () => {
    const db = seed({ analysis_claimed_at: minutesAgo(CLAIM_STALE_MINUTES + 1) })
    const result = await claimAndProcessInvoiceAnalysisRow(db, { ...stored(db) })
    expect(result).toEqual({ status: 'processed' })
    expect(prepareInvoiceRow).toHaveBeenCalledTimes(1)
  })

  it('two calls in a row prepare the row once', async () => {
    const db = seed()
    const row = { ...stored(db) }
    const first = await claimAndProcessInvoiceAnalysisRow(db, row)
    const second = await claimAndProcessInvoiceAnalysisRow(db, row)
    expect(first).toEqual({ status: 'processed' })
    expect(second).toEqual({ status: 'skipped' })
    expect(prepareInvoiceRow).toHaveBeenCalledTimes(1)
  })
})

describe.each([
  ['processInvoiceAnalysisRow (no claim)', (db, row) => processInvoiceAnalysisRow(db, row)],
  ['claimAndProcessInvoiceAnalysisRow', (db, row) => claimAndProcessInvoiceAnalysisRow(db, row)],
])('outcome mapping: %s', (_name, run) => {
  it.each([
    ['prepared', { status: 'processed' }],
    ['not_invoice', { status: 'processed' }],
    ['duplicate', { status: 'processed' }],
    ['unreadable', { status: 'processed', extractionError: 'unreadable' }],
    ['skipped', { status: 'skipped' }],
  ])('%s maps to %j', async (outcome, expected) => {
    prepareInvoiceRow.mockResolvedValue({ outcome, reasons: [] })
    const db = seed()
    expect(await run(db, { ...stored(db) })).toEqual(expected)
  })

  it('a throwing prepare clears the claim, keeps the row queued, and reports prepare_threw', async () => {
    prepareInvoiceRow.mockRejectedValue(new Error('kaboom'))
    const db = seed()
    const result = await run(db, { ...stored(db) })
    expect(result).toEqual({ status: 'processed', extractionError: 'prepare_threw' })
    expect(stored(db).analysis_claimed_at).toBeNull()
    expect(stored(db).analysis_queued_at).toEqual(expect.any(String))
    expect(logError).toHaveBeenCalled()
  })
})

describe('processInvoiceAnalysisRow', () => {
  it('does not claim: it calls prepare on the row it was given', async () => {
    const db = seed()
    const row = { ...stored(db) }
    await processInvoiceAnalysisRow(db, row)
    expect(prepareInvoiceRow).toHaveBeenCalledWith(db, row)
    expect(db.calls).toEqual([])
  })
})
