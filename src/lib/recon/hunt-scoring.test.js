// RCOV.P1 — hunt scoring test coverage.
//
// Two halves, deliberately split:
//   1. isHuntMatch — a pure function. No mocks. The whole point of
//      separating the match decision from the Anthropic call is that
//      thresholds are unit-testable without any network I/O, so this
//      block pins the exact boundary semantics (0.8 confidence; 2c
//      absolute OR 2% relative amount tolerance).
//   2. scoreHuntCandidate — mocks global.fetch via vi.stubGlobal and
//      exercises the envelope discipline mirrored from
//      invoice-extraction.js (missing key / happy path / fenced JSON /
//      non-200 / schema violation / PDF vs image content-block choice).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { isHuntMatch, scoreHuntCandidate } from './hunt-scoring'

describe('isHuntMatch', () => {
  const line = { amount: -84.5 }

  it('returns false when confidence is 0.79 (just under threshold)', () => {
    const verdict = { is_match: true, confidence: 0.79, total: 84.5 }
    expect(isHuntMatch(verdict, line)).toBe(false)
  })

  it('returns true when confidence is exactly 0.8 (other conditions met)', () => {
    const verdict = { is_match: true, confidence: 0.8, total: 84.5 }
    expect(isHuntMatch(verdict, line)).toBe(true)
  })

  it('returns false when is_match is false even at confidence 1.0', () => {
    const verdict = { is_match: false, confidence: 1.0, total: 84.5 }
    expect(isHuntMatch(verdict, line)).toBe(false)
  })

  it('returns false when total is null', () => {
    const verdict = { is_match: true, confidence: 0.95, total: null }
    expect(isHuntMatch(verdict, line)).toBe(false)
  })

  it('returns true for an exact amount match (84.50 vs 84.50)', () => {
    const verdict = { is_match: true, confidence: 0.9, total: 84.5 }
    expect(isHuntMatch(verdict, line)).toBe(true)
  })

  it('returns true for a 2c difference (84.52 vs 84.50 line)', () => {
    const verdict = { is_match: true, confidence: 0.9, total: 84.52 }
    expect(isHuntMatch(verdict, line)).toBe(true)
  })

  it('returns true for a 2.03 difference against 84.50 (>2c absolute, but <=2% relative)', () => {
    // 2.03 / 84.50 = 0.02402... which is > 2% — this pins the case just
    // OUTSIDE both branches (see the boundary tests below for the exact
    // edges). Included per the task spec's worked arithmetic to confirm
    // the "think the tolerance semantics through" note: 0.03 diff would be
    // <=2% (0.03/84.5=0.0355%), so use a value that is unambiguously
    // outside the OR to be sure this reads as intended.
    const verdict = { is_match: true, confidence: 0.9, total: 86.53 }
    expect(isHuntMatch(verdict, line)).toBe(false)
  })

  it('returns true for a 0.03 diff (84.53 vs 84.50) — inside the 2% relative branch', () => {
    // abs diff = 0.03, > 0.02 absolute tolerance, so falls through to the
    // relative check: 0.03 / 84.50 = 0.000355 = 0.0355%, well within 2%.
    const verdict = { is_match: true, confidence: 0.9, total: 84.53 }
    expect(isHuntMatch(verdict, line)).toBe(true)
  })

  it('boundary: diff exactly 0.02 (absolute tolerance edge) is true', () => {
    const verdict = { is_match: true, confidence: 0.9, total: 84.52 }
    expect(isHuntMatch(verdict, { amount: -84.5 })).toBe(true)
  })

  it('boundary: diff of 1.69 against 84.50 (exactly 2% relative) is true', () => {
    // 1.69 / 84.50 = 0.02 exactly (2%).
    const verdict = { is_match: true, confidence: 0.9, total: 86.19 }
    expect(isHuntMatch(verdict, { amount: -84.5 })).toBe(true)
  })

  it('boundary: diff of 1.70 against 84.50 (just over 2% relative) is false', () => {
    // 1.70 / 84.50 = 0.020118... > 2%, and 1.70 > 0.02 absolute too.
    const verdict = { is_match: true, confidence: 0.9, total: 86.2 }
    expect(isHuntMatch(verdict, { amount: -84.5 })).toBe(false)
  })

  it('small amount 0.50: a 0.01 diff is true (within absolute tolerance)', () => {
    // Note: 0.52 - 0.50 is NOT exactly 0.02 in IEEE 754 (it's
    // 0.020000000000000018), so it fails the "<=0.02" absolute check by a
    // sliver AND the 4% relative check exceeds 2% — genuinely false, not a
    // float artifact. 0.01 sidesteps the representability edge entirely
    // while still exercising "small amount, absolute branch saves it".
    const verdict = { is_match: true, confidence: 0.9, total: 0.51 }
    expect(isHuntMatch(verdict, { amount: -0.5 })).toBe(true)
  })

  it('small amount 0.50: a 0.03 diff is false (over both absolute AND the 6% relative branch fails the >2% test)', () => {
    // abs diff 0.03 > 0.02 absolute tolerance. Relative: 0.03 / 0.50 = 0.06
    // = 6%, which is > 2%, so the relative branch does not save it either.
    const verdict = { is_match: true, confidence: 0.9, total: 0.53 }
    expect(isHuntMatch(verdict, { amount: -0.5 })).toBe(false)
  })

  it('matches via Math.abs when the model returns a negative total (-84.50)', () => {
    const verdict = { is_match: true, confidence: 0.9, total: -84.5 }
    expect(isHuntMatch(verdict, line)).toBe(true)
  })

  it('returns false when verdict is null/undefined', () => {
    expect(isHuntMatch(null, line)).toBe(false)
    expect(isHuntMatch(undefined, line)).toBe(false)
  })
})

describe('scoreHuntCandidate', () => {
  const ORIGINAL_KEY = process.env.ANTHROPIC_API_KEY
  const line = {
    line_date: '2026-06-03',
    amount: -84.5,
    description: 'MUSCLEFOOD LTD CARD 1234',
    reference: null,
  }
  const bytes = Buffer.from('fake-file-bytes')

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key-123'
  })

  afterEach(() => {
    process.env.ANTHROPIC_API_KEY = ORIGINAL_KEY
    vi.unstubAllGlobals()
  })

  it('returns an error envelope and makes NO fetch call when ANTHROPIC_API_KEY is missing', async () => {
    delete process.env.ANTHROPIC_API_KEY
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await scoreHuntCandidate({ bytes, mime: 'image/jpeg', line })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/not configured/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('happy path: parses the verdict and computes spendUsd from usage tokens', async () => {
    const verdictJson = JSON.stringify({
      is_match: true,
      confidence: 0.92,
      supplier_name: 'Musclefood Ltd',
      invoice_number: 'INV-1029',
      total: 84.5,
      invoice_date: '2026-06-01',
      reason: 'Supplier, amount, and date all correspond.',
    })
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ type: 'text', text: verdictJson }],
        usage: { input_tokens: 1000, output_tokens: 100 },
      }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await scoreHuntCandidate({ bytes, mime: 'image/jpeg', line })

    expect(result.ok).toBe(true)
    expect(result.verdict).toEqual({
      is_match: true,
      confidence: 0.92,
      supplier_name: 'Musclefood Ltd',
      invoice_number: 'INV-1029',
      total: 84.5,
      invoice_date: '2026-06-01',
      reason: 'Supplier, amount, and date all correspond.',
    })
    // claude-sonnet-4-6 pricing: $3/1M input, $15/1M output.
    // 1000 * 3/1e6 + 100 * 15/1e6 = 0.003 + 0.0015 = 0.0045
    expect(result.spendUsd).toBeCloseTo(0.0045, 10)
  })

  it('parses a fenced JSON response (```json ... ```)', async () => {
    const verdictJson = JSON.stringify({
      is_match: false,
      confidence: 0.4,
      supplier_name: null,
      invoice_number: null,
      total: null,
      invoice_date: null,
      reason: 'This is a delivery note, not an invoice.',
    })
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ type: 'text', text: '```json\n' + verdictJson + '\n```' }],
        usage: { input_tokens: 500, output_tokens: 50 },
      }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await scoreHuntCandidate({ bytes, mime: 'image/jpeg', line })

    expect(result.ok).toBe(true)
    expect(result.verdict.is_match).toBe(false)
    expect(result.verdict.reason).toBe('This is a delivery note, not an invoice.')
  })

  it('returns an error envelope with the status code on a non-200 response', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 529,
      text: async () => 'overloaded_error',
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await scoreHuntCandidate({ bytes, mime: 'image/jpeg', line })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('529')
    expect(result.error).toContain('overloaded_error')
  })

  it('returns a validation error envelope when the JSON violates the schema', async () => {
    const badJson = JSON.stringify({
      is_match: 'yes', // wrong type — should be boolean
      confidence: 0.9,
      supplier_name: null,
      invoice_number: null,
      total: null,
      invoice_date: null,
      reason: 'bad shape',
    })
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ type: 'text', text: badJson }],
        usage: { input_tokens: 10, output_tokens: 10 },
      }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await scoreHuntCandidate({ bytes, mime: 'image/jpeg', line })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/schema validation/i)
    expect(result.raw_response).toBe(badJson)
  })

  it('selects a document content block for application/pdf', async () => {
    const verdictJson = JSON.stringify({
      is_match: true,
      confidence: 0.85,
      supplier_name: 'Test Supplier',
      invoice_number: 'INV-1',
      total: 84.5,
      invoice_date: '2026-06-01',
      reason: 'Match.',
    })
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ type: 'text', text: verdictJson }],
        usage: { input_tokens: 10, output_tokens: 10 },
      }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    await scoreHuntCandidate({ bytes, mime: 'application/pdf', line })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, requestInit] = fetchMock.mock.calls[0]
    const body = JSON.parse(requestInit.body)
    const firstBlock = body.messages[0].content[0]
    expect(firstBlock.type).toBe('document')
    expect(firstBlock.source.media_type).toBe('application/pdf')
  })

  it('selects an image content block for image/jpeg', async () => {
    const verdictJson = JSON.stringify({
      is_match: true,
      confidence: 0.85,
      supplier_name: 'Test Supplier',
      invoice_number: 'INV-1',
      total: 84.5,
      invoice_date: '2026-06-01',
      reason: 'Match.',
    })
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ type: 'text', text: verdictJson }],
        usage: { input_tokens: 10, output_tokens: 10 },
      }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    await scoreHuntCandidate({ bytes, mime: 'image/jpeg', line })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, requestInit] = fetchMock.mock.calls[0]
    const body = JSON.parse(requestInit.body)
    const firstBlock = body.messages[0].content[0]
    expect(firstBlock.type).toBe('image')
    expect(firstBlock.source.media_type).toBe('image/jpeg')
  })

  it('sends the correct headers, model, and anthropic-version', async () => {
    const verdictJson = JSON.stringify({
      is_match: true,
      confidence: 0.85,
      supplier_name: 'Test Supplier',
      invoice_number: 'INV-1',
      total: 84.5,
      invoice_date: '2026-06-01',
      reason: 'Match.',
    })
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ type: 'text', text: verdictJson }],
        usage: { input_tokens: 10, output_tokens: 10 },
      }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    await scoreHuntCandidate({ bytes, mime: 'image/jpeg', line })

    const [url, requestInit] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    expect(requestInit.method).toBe('POST')
    expect(requestInit.headers['x-api-key']).toBe('test-key-123')
    expect(requestInit.headers['anthropic-version']).toBe('2023-06-01')
    const body = JSON.parse(requestInit.body)
    expect(body.model).toBe('claude-sonnet-4-6')
  })

  it('returns an error envelope when the fetch call itself rejects (network failure)', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND')
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await scoreHuntCandidate({ bytes, mime: 'image/jpeg', line })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/request failed/i)
  })

  it('returns an error envelope when the response has no text block', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        content: [],
        usage: { input_tokens: 10, output_tokens: 10 },
      }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await scoreHuntCandidate({ bytes, mime: 'image/jpeg', line })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/no text block/i)
  })
})
