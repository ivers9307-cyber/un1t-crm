// HOSTPORTAL.2 — /edit is now only a redirect to the Set up tab, after the same
// host check as every other route (another host's id never confirms it exists).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const redirect = vi.fn((url) => { throw new Error(`REDIRECT:${url}`) })
vi.mock('next/navigation', () => ({ notFound: vi.fn(() => { throw new Error('NOT_FOUND') }), redirect }))

const state = { session: { host: { id: 'h1' } }, event: null }

vi.mock('@/lib/host-auth', () => ({ getCurrentHost: vi.fn(async () => state.session) }))
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    from: () => {
      const b = {}
      b.select = () => b
      b.eq = () => b
      b.maybeSingle = async () => ({ data: state.event, error: null })
      return b
    },
  }),
}))
vi.mock('@/lib/host-org-brand', () => ({ resolveHostOrgBrand: vi.fn(async () => ({ name: 'Brand X' })) }))

const { default: Page } = await import('./page.js')

const call = () => Page({ params: Promise.resolve({ id: 'e1' }) })

beforeEach(() => {
  redirect.mockClear()
  state.session = { host: { id: 'h1' } }
  state.event = { id: 'e1', host_id: 'h1' }
})

describe('host edit event page (redirect)', () => {
  it('redirects its own event to the Set up tab', async () => {
    await expect(call()).rejects.toThrow('REDIRECT:/host/events/e1/setup')
  })
  it('404s for another host\'s event instead of redirecting', async () => {
    state.event = { id: 'e1', host_id: 'other' }
    await expect(call()).rejects.toThrow('NOT_FOUND')
    expect(redirect).not.toHaveBeenCalled()
  })
  it('404s for a missing event', async () => {
    state.event = null
    await expect(call()).rejects.toThrow('NOT_FOUND')
  })
  it('redirects to login without a session', async () => {
    state.session = null
    await expect(call()).rejects.toThrow('REDIRECT:/host/login')
  })
})
