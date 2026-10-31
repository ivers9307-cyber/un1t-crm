// PAGES.1 — /welcome/[location] (+ /events, /status) are redirects to the
// studio page on the one [slug] route, the query kept as it came. The
// TRIALFIRST.1 and EDITGATE.1 cases that rendered here now run against the
// [slug] route (src/app/(public)/[slug]/[[...rest]]/page.test.jsx).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({ redirect: vi.fn(), notFound: vi.fn() }))
vi.mock('next/navigation', () => ({
  redirect: (u) => { mocks.redirect(u); throw Object.assign(new Error('NEXT_REDIRECT'), { url: u }) },
  notFound: () => { mocks.notFound(); throw new Error('NEXT_NOT_FOUND') },
}))

import StudioPage from './page.js'
import EventsPage from './events/page.js'
import StatusPage from './status/page.js'

const PURCHASE = '11111111-1111-1111-1111-111111111111'
const call = async (Page, location, sp = {}) => {
  try {
    await Page({ params: Promise.resolve({ location }), searchParams: Promise.resolve(sp) })
    return 'rendered'
  } catch (e) {
    return e.message === 'NEXT_REDIRECT' ? `redirect ${e.url}` : e.message
  }
}

beforeEach(() => {
  mocks.redirect.mockClear()
  mocks.notFound.mockClear()
})

describe('/welcome/[location] redirects to the studio page', () => {
  it('/welcome/stillorgan redirects to /stillorgan with the query', async () => {
    expect(await call(StudioPage, 'stillorgan', { utm_source: 'ig', utm_campaign: 'oct' })).toBe('redirect /stillorgan?utm_source=ig&utm_campaign=oct')
    expect(await call(StudioPage, 'hatch-street')).toBe('redirect /hatch-street')
  })

  it('a checkout return keeps its purchase and cancel flag, so the card still resumes', async () => {
    expect(await call(StudioPage, 'hatch-street', { purchase: PURCHASE, cancelled: '1' })).toBe(`redirect /hatch-street?purchase=${PURCHASE}&cancelled=1`)
  })

  it('the editor preview flag travels too (the [slug] route judges it)', async () => {
    expect(await call(StudioPage, 'stillorgan', { edit: '1' })).toBe('redirect /stillorgan?edit=1')
  })

  it('/events and /status go to the sub-pages under the slug', async () => {
    expect(await call(EventsPage, 'stillorgan', { ref: 'nav' })).toBe('redirect /stillorgan/events?ref=nav')
    expect(await call(StatusPage, 'hatch-street')).toBe('redirect /hatch-street/status')
  })

  it('a repeated key keeps every value', async () => {
    expect(await call(StudioPage, 'stillorgan', { tag: ['a', 'b'] })).toBe('redirect /stillorgan?tag=a&tag=b')
  })

  it('a path that is not a slug 404s and never redirects', async () => {
    for (const Page of [StudioPage, EventsPage, StatusPage]) {
      expect(await call(Page, '%2F%2Fevil.com')).toBe('NEXT_NOT_FOUND')
      expect(await call(Page, 'Bad Path')).toBe('NEXT_NOT_FOUND')
    }
    expect(mocks.redirect).not.toHaveBeenCalled()
  })
})
