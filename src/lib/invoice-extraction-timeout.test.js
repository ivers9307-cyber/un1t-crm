// @vitest-environment node
// INVOICEPREP.3 — the reader call has a deadline. A read that never answers
// must not hold the preparation worker until the platform kills it (after the
// read was paid for); it ends as a returned reader failure, which preparation
// records as unreadable like any other failed read.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/anthropic', () => ({ anthropicMessages: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

const { anthropicMessages } = await import('@/lib/anthropic')
const { extractInvoiceFieldsFromBytes, EXTRACTION_TIMEOUT_MS } = await import('./invoice-extraction.js')

const PDF = Buffer.from('%PDF-1.4\nsample\n', 'latin1')

beforeEach(() => { vi.stubEnv('ANTHROPIC_API_KEY', 'test-key') })
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

describe('extractInvoiceFieldsFromBytes — deadline', () => {
  it('is 90 seconds', () => {
    expect(EXTRACTION_TIMEOUT_MS).toBe(90_000)
  })

  it('passes an abort signal to the reader call', async () => {
    anthropicMessages.mockResolvedValue({ res: { ok: false, status: 500, text: async () => 'x' }, data: null })
    await extractInvoiceFieldsFromBytes(PDF, 'application/pdf', { locationId: 'loc' })
    const meta = anthropicMessages.mock.calls[0][1]
    expect(meta.signal).toBeInstanceOf(AbortSignal)
    expect(meta.source).toBe('invoice_ocr')
  })

  it('a timed-out read is a failed read with a plain message', async () => {
    // What fetch rejects with when AbortSignal.timeout fires.
    anthropicMessages.mockRejectedValue(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
    const out = await extractInvoiceFieldsFromBytes(PDF, 'application/pdf', {})
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/timed out after 90 s/)
  })
})
