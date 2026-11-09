// HOSTPORTAL.1 — the edit page carries the Submit button for a draft or a
// rejected event (the bridge until Submit moves into the event page).
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
vi.mock('@/lib/host-event-form-initial', () => ({ hostEventFormInitial: vi.fn(() => ({})) }))
vi.mock('@/components/host/HostEventForm', () => ({ default: function HostEventForm() { return null } }))
vi.mock('@/components/host/HostSubmitButton', () => ({ default: function HostSubmitButton() { return null } }))

const { default: Page } = await import('./page.js')
const { default: HostSubmitButton } = await import('@/components/host/HostSubmitButton')

function walk(el, visit) {
  if (!el || typeof el !== 'object') return
  if (Array.isArray(el)) { el.forEach((c) => walk(c, visit)); return }
  visit(el)
  walk(el.props?.children, visit)
}
function all(el, type) { const out = []; walk(el, (n) => { if (n.type === type) out.push(n) }); return out }
function text(el) {
  let s = ''
  const go = (n) => {
    if (n == null || typeof n === 'boolean') return
    if (typeof n === 'string' || typeof n === 'number') { s += n; return }
    if (Array.isArray(n)) { n.forEach(go); return }
    go(n.props?.children)
  }
  go(el)
  return s
}
const call = () => Page({ params: Promise.resolve({ id: 'e1' }) })

beforeEach(() => {
  redirect.mockClear()
  state.session = { host: { id: 'h1' } }
  state.event = { id: 'e1', host_id: 'h1', status: 'draft', rejected_reason: null, race_waves: [] }
})

describe('host edit event page — submit bridge', () => {
  it.each(['draft', 'rejected'])('renders the Submit button for a %s event, with the finish-and-submit line', async (status) => {
    state.event = { ...state.event, status }
    const el = await call()
    const buttons = all(el, HostSubmitButton)
    expect(buttons).toHaveLength(1)
    expect(buttons[0].props).toEqual({ eventId: 'e1' })
    expect(text(el)).toContain('When you have finished your changes, save them, then submit the event for review.')
  })
  it.each(['pending_review', 'published'])('renders no Submit button for a %s event', async (status) => {
    state.event = { ...state.event, status }
    const el = await call()
    expect(all(el, HostSubmitButton)).toHaveLength(0)
    expect(text(el)).not.toContain('submit the event for review')
  })
  it('answers 404 for another host\'s event', async () => {
    state.event = { ...state.event, host_id: 'other' }
    await expect(call()).rejects.toThrow('NOT_FOUND')
  })
  it('redirects to login without a session', async () => {
    state.session = null
    await expect(call()).rejects.toThrow('REDIRECT:/host/login')
  })
})
