// HOSTPORTAL.2 — the Set up tab: the edit form for every status, behind the
// same host gate as every other tab.
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
vi.mock('@/components/host/HostEventForm', () => ({ default: function HostEventForm() { return null } }))

const { default: Page } = await import('./page.js')
const { default: HostEventForm } = await import('@/components/host/HostEventForm')

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
  state.event = {
    id: 'e1', host_id: 'h1', status: 'draft', rejected_reason: null, name: 'Mobility',
    rating_email_subject: 'How was it?', rating_email_intro: 'Tell us.', race_waves: [],
  }
})

describe('host Set up page', () => {
  it('404s for another host\'s event', async () => {
    state.event = { ...state.event, host_id: 'other' }
    await expect(call()).rejects.toThrow('NOT_FOUND')
  })
  it('404s for a missing event', async () => {
    state.event = null
    await expect(call()).rejects.toThrow('NOT_FOUND')
  })
  it('redirects to login without a session', async () => {
    state.session = null
    await expect(call()).rejects.toThrow('REDIRECT:/host/login')
  })
  it.each(['draft', 'rejected', 'pending_review', 'published'])('renders the edit form for a %s event, with its status', async (status) => {
    state.event = { ...state.event, status }
    const forms = all(await call(), HostEventForm)
    expect(forms).toHaveLength(1)
    expect(forms[0].props).toMatchObject({ mode: 'edit', eventId: 'e1', brandName: 'Brand X', status })
  })
  it('passes the rating email copy into the form', async () => {
    const [form] = all(await call(), HostEventForm)
    expect(form.props.initial).toMatchObject({ rating_email_subject: 'How was it?', rating_email_intro: 'Tell us.' })
  })
  it('shows the reviewer note on a rejected event, and no header of its own', async () => {
    state.event = { ...state.event, status: 'rejected', rejected_reason: 'Please add a venue address.' }
    const el = await call()
    expect(text(el)).toContain('Brand X asked for changes: Please add a venue address.')
    expect(text(el)).not.toContain('Edit event')
    expect(text(el)).not.toContain('Back')
  })
  it('shows no reviewer note when the event is not rejected', async () => {
    state.event = { ...state.event, status: 'draft', rejected_reason: 'stale' }
    expect(text(await call())).not.toContain('asked for changes')
  })
})
