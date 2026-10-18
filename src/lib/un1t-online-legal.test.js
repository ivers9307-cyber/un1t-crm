// UN1TWRITE.17 — the studio's un1t.online terms and waiver, read with its token.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readUn1tLegalDocs, legalDocPathFor, _resetUn1tLegalCacheForTests, UN1T_LEGAL_TTL_MS, UN1T_LEGAL_FAILURE_TTL_MS } from './un1t-online-legal'

const TERMS = '/studios/S-1/legal/terms-and-conditions'
const WAIVER = '/studios/S-1/legal/liability-waiver'

function fakeWriter({ answers = {}, studioId = 'S-1' } = {}) {
  const reads = []
  return {
    reads,
    writer: {
      studioId,
      read: vi.fn(async (path) => {
        reads.push(path)
        const a = answers[path]
        if (a instanceof Error) throw a
        return a
      }),
    },
  }
}

const ok = {
  [TERMS]: { content: 'Terms text', updated_at: '2026-09-01T10:00:00Z' },
  [WAIVER]: { content: 'Waiver text', updated_at: '2026-09-02T10:00:00Z' },
}

let clock
beforeEach(() => {
  _resetUn1tLegalCacheForTests()
  clock = 1_000_000
})
const deps = (w) => ({ createWriter: vi.fn(async () => w.writer), now: () => clock })

describe('readUn1tLegalDocs', () => {
  it('reads both documents with the studio token once per hour per location', async () => {
    const w = fakeWriter({ answers: ok })
    const d = deps(w)
    const first = await readUn1tLegalDocs({}, 'HATCH', d)
    expect(first.terms).toEqual({ content: 'Terms text', updatedAt: '2026-09-01T10:00:00Z' })
    expect(first.waiver).toEqual({ content: 'Waiver text', updatedAt: '2026-09-02T10:00:00Z' })
    expect(w.reads).toEqual([TERMS, WAIVER])
    clock += UN1T_LEGAL_TTL_MS - 1
    await readUn1tLegalDocs({}, 'HATCH', d)
    expect(w.reads).toHaveLength(2)
    clock += 2
    await readUn1tLegalDocs({}, 'HATCH', d)
    expect(w.reads).toHaveLength(4)
    // Another studio has its own entry.
    await readUn1tLegalDocs({}, 'OTHER', d)
    expect(w.reads).toHaveLength(6)
  })

  it('version joins both updated_at values; null when either failed', async () => {
    const both = await readUn1tLegalDocs({}, 'A', deps(fakeWriter({ answers: ok })))
    expect(both.version).toBe('terms:2026-09-01T10:00:00Z|waiver:2026-09-02T10:00:00Z')
    const half = await readUn1tLegalDocs({}, 'B', deps(fakeWriter({ answers: { [TERMS]: ok[TERMS], [WAIVER]: new Error('boom') } })))
    expect(half.terms?.content).toBe('Terms text')
    expect(half.waiver).toBeNull()
    expect(half.version).toBeNull()
  })

  it('a failed read returns null and never throws; a failure is retried only after a minute', async () => {
    const w = fakeWriter({ answers: { [TERMS]: new Error('x'), [WAIVER]: new Error('y') } })
    const d = deps(w)
    await expect(readUn1tLegalDocs({}, 'C', d)).resolves.toEqual({ terms: null, waiver: null, version: null })
    await readUn1tLegalDocs({}, 'C', d)
    expect(w.reads).toHaveLength(2)
    clock += UN1T_LEGAL_FAILURE_TTL_MS
    await readUn1tLegalDocs({}, 'C', d)
    expect(w.reads).toHaveLength(4)
    const broken = { createWriter: vi.fn(async () => { throw new Error('settings unreadable') }), now: () => clock }
    await expect(readUn1tLegalDocs({}, 'D', broken)).resolves.toEqual({ terms: null, waiver: null, version: null })
  })

  it('caches each document on its own: a missing waiver never re-reads the terms', async () => {
    const w = fakeWriter({ answers: { [TERMS]: ok[TERMS], [WAIVER]: new Error('404') } })
    const d = deps(w)
    await readUn1tLegalDocs({}, 'H', d)
    clock += UN1T_LEGAL_FAILURE_TTL_MS
    const again = await readUn1tLegalDocs({}, 'H', d)
    expect(w.reads).toEqual([TERMS, WAIVER, WAIVER])
    expect(again.terms?.content).toBe('Terms text')
  })

  it('concurrent views share one read; the writer gets one attempt with no waits and a timed fetch', async () => {
    const w = fakeWriter({ answers: ok })
    const d = deps(w)
    await Promise.all([readUn1tLegalDocs({}, 'I', d), readUn1tLegalDocs({}, 'I', d), readUn1tLegalDocs({}, 'I', d)])
    expect(d.createWriter).toHaveBeenCalledTimes(1)
    expect(w.reads).toHaveLength(2)
    const opts = d.createWriter.mock.calls[0][2]
    expect(typeof opts.fetchImpl).toBe('function')
    await expect(opts.sleep(1000)).rejects.toThrow(/does not wait/)
  })

  it('the cache is keyed by the token studio too, and hands out copies', async () => {
    const a = fakeWriter({ answers: ok })
    const first = await readUn1tLegalDocs({}, 'J', deps(a))
    first.terms.content = 'tampered'
    const b = fakeWriter({ answers: { '/studios/S-2/legal/terms-and-conditions': { content: 'Other' }, '/studios/S-2/legal/liability-waiver': { content: 'W2' } }, studioId: 'S-2' })
    const second = await readUn1tLegalDocs({}, 'J', deps(b))
    expect(second.terms.content).toBe('Other')
    const third = await readUn1tLegalDocs({}, 'J', deps(a))
    expect(third.terms.content).toBe('Terms text')
  })

  it('a studio with no studio id or no text is null, never a guessed document', async () => {
    const noStudio = await readUn1tLegalDocs({}, 'E', deps(fakeWriter({ answers: ok, studioId: null })))
    expect(noStudio).toEqual({ terms: null, waiver: null, version: null })
    const empty = await readUn1tLegalDocs({}, 'F', deps(fakeWriter({ answers: { [TERMS]: { content: '' }, [WAIVER]: 'Plain text waiver' } })))
    expect(empty.terms).toBeNull()
    expect(empty.waiver).toEqual({ content: 'Plain text waiver', updatedAt: null })
  })

  it('a document with no updated_at still has a version (a short hash of its text)', async () => {
    const out = await readUn1tLegalDocs({}, 'G', deps(fakeWriter({ answers: { [TERMS]: { content: 'a' }, [WAIVER]: { content: 'b', updated_at: '2026-09-02T10:00:00Z' } } })))
    expect(out.version).toMatch(/^terms:sha256-[0-9a-f]{12}\|waiver:2026-09-02T10:00:00Z$/)
  })
})

describe('legalDocPathFor', () => {
  it('builds the public page path', () => {
    expect(legalDocPathFor('hatch-street', 'terms')).toBe('/legal/un1t/hatch-street/terms')
    expect(legalDocPathFor('hatch-street', 'waiver')).toBe('/legal/un1t/hatch-street/waiver')
    expect(() => legalDocPathFor('hatch-street', 'privacy')).toThrow(TypeError)
  })
})
