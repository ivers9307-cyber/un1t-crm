import { describe, it, expect, beforeEach } from 'vitest'
import {
  LEGACY_FAVICON_URL,
  FAVICON_CACHE_TTL_MS,
  resolveDefaultFaviconUrl,
  _resetDefaultFaviconCache,
} from './default-favicon.js'

// supabase-builder mock for the helper's single query shape:
// from('company_settings').select().not().order().limit() — resolves at
// limit(). Counts calls so the TTL-cache tests can assert "no second
// round-trip inside the TTL".
function mockDb(result, counter = { calls: 0 }) {
  return {
    counter,
    from() { return this },
    select() { return this },
    not() { return this },
    order() { return this },
    limit() {
      this.counter.calls += 1
      if (result instanceof Error) return Promise.reject(result)
      return Promise.resolve(result)
    },
  }
}

const T0 = 1_800_000_000_000

beforeEach(() => _resetDefaultFaviconCache())

describe('LEGACY_FAVICON_URL', () => {
  it('pins the exact pre-SAAS-7 hardcoded root-layout favicon (fallback equivalence)', () => {
    expect(LEGACY_FAVICON_URL).toBe(
      'https://iyvtbjjxdggiadzwwvdj.supabase.co/storage/v1/object/public/branding/a0000000-0000-0000-0000-000000000001/favicon.png'
    )
  })
})

describe('resolveDefaultFaviconUrl', () => {
  it('returns the configured company_settings favicon when present', async () => {
    const db = mockDb({ data: [{ favicon_url: 'https://cdn/f.png' }], error: null })
    expect(await resolveDefaultFaviconUrl({ db, nowMs: T0 })).toBe('https://cdn/f.png')
  })

  it('falls back to the legacy URL when no row is configured', async () => {
    const db = mockDb({ data: [], error: null })
    expect(await resolveDefaultFaviconUrl({ db, nowMs: T0 })).toBe(LEGACY_FAVICON_URL)
  })

  it('falls back to the legacy URL on a query error (never throws)', async () => {
    const db = mockDb({ data: null, error: { message: 'boom' } })
    expect(await resolveDefaultFaviconUrl({ db, nowMs: T0 })).toBe(LEGACY_FAVICON_URL)
  })

  it('falls back to the legacy URL when the client itself throws (DB blip)', async () => {
    const db = mockDb(new Error('network down'))
    expect(await resolveDefaultFaviconUrl({ db, nowMs: T0 })).toBe(LEGACY_FAVICON_URL)
  })

  it('caches inside the TTL — a second call does not re-query', async () => {
    const counter = { calls: 0 }
    const db = mockDb({ data: [{ favicon_url: 'https://cdn/f.png' }], error: null }, counter)
    await resolveDefaultFaviconUrl({ db, nowMs: T0 })
    const again = await resolveDefaultFaviconUrl({ db, nowMs: T0 + FAVICON_CACHE_TTL_MS - 1 })
    expect(again).toBe('https://cdn/f.png')
    expect(counter.calls).toBe(1)
  })

  it('re-queries once the TTL has elapsed (picks up a new upload)', async () => {
    const counter = { calls: 0 }
    const first = mockDb({ data: [{ favicon_url: 'https://cdn/old.png' }], error: null }, counter)
    await resolveDefaultFaviconUrl({ db: first, nowMs: T0 })
    const second = mockDb({ data: [{ favicon_url: 'https://cdn/new.png' }], error: null }, counter)
    expect(await resolveDefaultFaviconUrl({ db: second, nowMs: T0 + FAVICON_CACHE_TTL_MS })).toBe('https://cdn/new.png')
    expect(counter.calls).toBe(2)
  })

  it('caches the fallback too, so a down DB is not hammered per-request', async () => {
    const counter = { calls: 0 }
    const db = mockDb(new Error('down'), counter)
    await resolveDefaultFaviconUrl({ db, nowMs: T0 })
    await resolveDefaultFaviconUrl({ db, nowMs: T0 + 1 })
    expect(counter.calls).toBe(1)
  })
})
