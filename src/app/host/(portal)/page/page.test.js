// HOSTPORTAL.1 — /host/page: the public-page editor. Server page reads the
// slug, base url, signup count and copy, and hands plain data to HostYourPage.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const redirect = vi.fn((url) => { throw new Error(`REDIRECT:${url}`) })
vi.mock('next/navigation', () => ({ notFound: vi.fn(), redirect }))

const state = { session: null, hostRow: null, hostErr: null, count: 4, slugThrows: false, baseThrows: false, base: 'https://tenant.test/anything?x=1' }

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/host-auth', () => ({ getCurrentHost: vi.fn(async () => state.session) }))
vi.mock('@/lib/hosts', () => ({
  ensureHostSlug: vi.fn(async () => { if (state.slugThrows) throw new Error('boom'); return 'acme' }),
}))
vi.mock('@/lib/tenant-host', () => ({
  resolveCustomerBaseUrl: vi.fn(async () => { if (state.baseThrows) throw new Error('boom'); return state.base }),
}))
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    from: (table) => {
      if (table === 'event_hosts') {
        const c = { select: () => c, eq: () => c, maybeSingle: async () => ({ data: state.hostRow, error: state.hostErr }) }
        return c
      }
      const c = { select: () => c, eq: () => c, then: (res) => res({ count: state.count, error: null }) }
      return c
    },
  }),
}))
vi.mock('@/components/host/HostYourPage', () => ({ default: function HostYourPage() { return null } }))

const { default: Page } = await import('./page.js')
const { default: HostYourPage } = await import('@/components/host/HostYourPage')

function walk(el, visit) {
  if (!el || typeof el !== 'object') return
  if (Array.isArray(el)) { el.forEach((c) => walk(c, visit)); return }
  visit(el)
  walk(el.props?.children, visit)
}
function find(el, type) { let out = null; walk(el, (n) => { if (!out && n.type === type) out = n }); return out }
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

beforeEach(() => {
  redirect.mockClear()
  state.session = { host: { id: 'h1' } }
  state.hostRow = {
    id: 'h1', name: 'Acme', slug: 'acme', anchor_location_id: 'l1',
    list_headline: 'Join us', list_blurb: null, list_button_label: null, list_success_message: null,
    hero_image_url: null, accent_hex: null, events_headline: null, events_blurb: null,
    about_text: 'Hi', photos: [], testimonials: [], show_past_events: null, show_ratings: false,
  }
  state.hostErr = null
  state.count = 4
  state.slugThrows = false
  state.baseThrows = false
})

describe('host page', () => {
  it('redirects to login without a session', async () => {
    state.session = null
    await expect(Page()).rejects.toThrow('REDIRECT:/host/login')
  })
  it('hands HostYourPage plain data: origin-only urls, the count and the copy', async () => {
    const el = await Page()
    const node = find(el, HostYourPage)
    expect(node.props.url).toBe('https://tenant.test/h/acme')
    expect(node.props.joinUrl).toBe('https://tenant.test/h/acme/join')
    expect(node.props.signupCount).toBe(4)
    expect(node.props.copyValues.list_headline).toBe('Join us')
    expect(node.props.copyValues.about_text).toBe('Hi')
    expect(node.props.copyValues.show_past_events).toBe(true)
    expect(node.props.copyValues.show_ratings).toBe(false)
    for (const v of Object.values(node.props)) expect(typeof v).not.toBe('function')
  })
  it('renders a heading', async () => {
    expect(text(await Page())).toContain('Your page')
  })
  it('says unavailable under the heading when the slug read throws', async () => {
    state.slugThrows = true
    const el = await Page()
    expect(find(el, HostYourPage)).toBeNull()
    expect(text(el)).toContain('Your page')
    expect(text(el)).toContain('Your page is unavailable right now.')
  })
  it('says unavailable when the base url cannot be resolved', async () => {
    state.baseThrows = true
    const el = await Page()
    expect(find(el, HostYourPage)).toBeNull()
    expect(text(el)).toContain('Your page is unavailable right now.')
  })
  it('says unavailable when the host row read errors or is missing', async () => {
    state.hostErr = { message: 'x' }
    expect(text(await Page())).toContain('Your page is unavailable right now.')
    state.hostErr = null
    state.hostRow = null
    expect(text(await Page())).toContain('Your page is unavailable right now.')
  })
})
