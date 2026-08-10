import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = { endsAt: null, dbThrows: false }

vi.mock('@/lib/supabase', () => ({
  createServerClient: () => {
    if (state.dbThrows) throw new Error('db down')
    return {
      from() { return this }, select() { return this }, eq() { return this },
      order() { return this }, limit() { return this },
      maybeSingle: async () => ({ data: state.endsAt ? { ends_at: state.endsAt } : null }),
    }
  },
}))

const buildCountdownGif = vi.fn(async () => Buffer.from('GIF89a-pretend-frames'))
vi.mock('@/lib/countdown-gif', () => ({ buildCountdownGif: (...a) => buildCountdownGif(...a) }))

import { GET } from './route'

beforeEach(() => {
  state.endsAt = new Date(Date.now() + 5 * 3600e3).toISOString()
  state.dbThrows = false
  buildCountdownGif.mockClear()
})

const BLANK_LEN = 42 // bytes of the 1×1 transparent fallback

async function expectBlankGif(res) {
  const bytes = Buffer.from(await res.arrayBuffer())
  expect(bytes).toHaveLength(BLANK_LEN)
  expect(bytes.subarray(0, 6).toString('latin1')).toBe('GIF89a')
}

describe('GET /api/public/countdown.gif', () => {
  it('serves image/gif with cache defeated on every hop', async () => {
    const res = await GET()
    expect(res.headers.get('content-type')).toBe('image/gif')
    expect(res.headers.get('cache-control')).toContain('no-store')
    expect(res.headers.get('cache-control')).toContain('must-revalidate')
    expect(res.headers.get('pragma')).toBe('no-cache')
    expect(res.headers.get('expires')).toBe('0')
  })

  it('renders the time remaining to the live deadline', async () => {
    await GET()
    const { msLeft } = buildCountdownGif.mock.calls[0][0]
    // ~5h, allowing for clock drift between fixture and call
    expect(msLeft).toBeGreaterThan(4.9 * 3600e3)
    expect(msLeft).toBeLessThanOrEqual(5 * 3600e3)
  })

  it('passes a negative remainder straight through once the sale has closed', async () => {
    state.endsAt = new Date(Date.now() - 60_000).toISOString()
    await GET()
    expect(buildCountdownGif.mock.calls[0][0].msLeft).toBeLessThan(0)
  })

  it('falls back to a blank pixel when no active sale exists', async () => {
    state.endsAt = null
    const res = await GET()
    expect(res.headers.get('content-type')).toBe('image/gif')
    await expectBlankGif(res)
    expect(buildCountdownGif).not.toHaveBeenCalled()
  })

  it('degrades to a blank pixel — never a broken image — if rendering throws', async () => {
    buildCountdownGif.mockRejectedValueOnce(new Error('encode exploded'))
    const res = await GET()
    expect(res.status).toBe(200)
    await expectBlankGif(res)
  })

  it('degrades the same way if the database is unreachable', async () => {
    state.dbThrows = true
    const res = await GET()
    expect(res.status).toBe(200)
    await expectBlankGif(res)
  })
})
