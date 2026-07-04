// RCOV.P2 — manual-upload helpers (hash / sanitize / dedupe lookup).
import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'crypto'
import { prepareManualUpload, findQueueRowByHash } from './manual-upload'

describe('prepareManualUpload', () => {
  it('hashes bytes with sha256 hex and sanitizes the filename', () => {
    const bytes = Buffer.from('receipt-bytes')
    const out = prepareManualUpload({ bytes, filename: 'Café receipt (June).PDF' })
    expect(out.contentHash).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(out.contentHash).toMatch(/^[a-f0-9]{64}$/)
    expect(out.safeName).toBe('Caf__receipt__June_.PDF')
  })

  it('is deterministic for identical bytes regardless of filename', () => {
    const a = prepareManualUpload({ bytes: Buffer.from('x'), filename: 'a.pdf' })
    const b = prepareManualUpload({ bytes: Buffer.from('x'), filename: 'b.pdf' })
    expect(a.contentHash).toBe(b.contentHash)
  })

  it('falls back to "receipt" for empty filenames and caps length at 80', () => {
    expect(prepareManualUpload({ bytes: Buffer.from('x'), filename: '' }).safeName).toBe('receipt')
    const long = prepareManualUpload({ bytes: Buffer.from('x'), filename: `${'a'.repeat(200)}.pdf` })
    expect(long.safeName.length).toBeLessThanOrEqual(80)
    expect(long.safeName.endsWith('.pdf')).toBe(true)
  })
})

describe('findQueueRowByHash', () => {
  const chain = (result) => {
    const c = {}
    for (const m of ['select', 'eq', 'limit']) c[m] = vi.fn().mockReturnThis()
    c.maybeSingle = vi.fn().mockResolvedValue(result)
    return c
  }

  it('returns the existing row id on a hash hit', async () => {
    const db = { from: vi.fn().mockReturnValue(chain({ data: { id: 'q-1' }, error: null })) }
    await expect(findQueueRowByHash(db, 'abc')).resolves.toEqual({ existingId: 'q-1' })
  })

  it('returns null when no row carries the hash', async () => {
    const db = { from: vi.fn().mockReturnValue(chain({ data: null, error: null })) }
    await expect(findQueueRowByHash(db, 'abc')).resolves.toEqual({ existingId: null })
  })

  it('throws with a greppable prefix on query error', async () => {
    const db = { from: vi.fn().mockReturnValue(chain({ data: null, error: { message: 'boom' } })) }
    await expect(findQueueRowByHash(db, 'abc')).rejects.toThrow(/manual-upload hash lookup failed: boom/)
  })
})
