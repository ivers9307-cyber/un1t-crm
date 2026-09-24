// SCHED.9 — /schedule root: Reporting's local useState switch becomes a
// server-read ?view=reporting search param (Reporting has no standalone
// sibling page to converge onto, unlike the other five tabs — see the
// header comment in src/components/ScheduleTabs.jsx). Mirrors the
// renderToStaticMarkup pattern from ../expenses/page.test.js.

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url) => {
    const err = new Error(`NEXT_REDIRECT:${url}`)
    err.digest = `NEXT_REDIRECT;${url}`
    throw err
  }),
  usePathname: () => '/schedule',
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('@/components/ScheduleRosterView', () => ({ default: () => <div>roster-view-stub</div> }))
vi.mock('@/components/ScheduleReporting', () => ({ default: () => <div>reporting-stub</div> }))

import SchedulePage, * as pageModule from './page.js'
import { getCurrentUser } from '@/lib/auth'

function user({ role = 'manager' } = {}) {
  return {
    id: 'u1',
    role,
    activeAssignment: { permissions: {} },
    activeLocation: { id: 'loc1', features: {} },
  }
}

beforeEach(() => vi.clearAllMocks())

describe('/schedule root — ?view=reporting search param', () => {
  it('redirects to /login without a session', async () => {
    getCurrentUser.mockResolvedValue(null)
    await expect(SchedulePage({ searchParams: Promise.resolve({}) })).rejects.toThrow(/^NEXT_REDIRECT:\/login$/)
  })

  it('renders the roster view by default', async () => {
    getCurrentUser.mockResolvedValue(user())
    const html = renderToStaticMarkup(await SchedulePage({ searchParams: Promise.resolve({}) }))
    expect(html).toContain('roster-view-stub')
    expect(html).not.toContain('reporting-stub')
  })

  it('renders Reporting for a manager on ?view=reporting', async () => {
    getCurrentUser.mockResolvedValue(user())
    const html = renderToStaticMarkup(await SchedulePage({ searchParams: Promise.resolve({ view: 'reporting' }) }))
    expect(html).toContain('reporting-stub')
    expect(html).not.toContain('roster-view-stub')
  })

  it('ignores ?view=reporting for a non-manager (falls back to the roster, same population that never sees the Reporting tab)', async () => {
    getCurrentUser.mockResolvedValue(user({ role: 'staff' }))
    const html = renderToStaticMarkup(await SchedulePage({ searchParams: Promise.resolve({ view: 'reporting' }) }))
    expect(html).toContain('roster-view-stub')
    expect(html).not.toContain('reporting-stub')
  })
})

// ROSTERTIDY.1 — a CLASS PIN, not a layout proof (jsdom/static markup has no
// layout engine). It only stops the wrapper regressing to a bare `p-8`, which
// left 32px side margins on a 360px phone; whether 16px actually renders is a
// browser check.
describe('/schedule root — wrapper padding classes', () => {
  it('uses 16px side padding below sm and p-8 from sm up', async () => {
    getCurrentUser.mockResolvedValue(user())
    const html = renderToStaticMarkup(await SchedulePage({ searchParams: Promise.resolve({}) }))
    const firstClass = html.match(/^<div class="([^"]*)"/)?.[1] || ''
    expect(firstClass.split(' ')).toEqual(expect.arrayContaining(['px-4', 'py-6', 'sm:p-8']))
    expect(firstClass.split(' ')).not.toContain('p-8')
  })
})

// ROSTERLOOK.1 — the tab read "UN1T Hatch Street" with the Stillorgan roster on
// screen: the root layout's title is the first company_settings row by
// location_id, for everyone. TABTITLE.1 moved the studio name up into
// (team)/layout.js (title.template), so this page now only names ITSELF. That
// the two still compose to "Schedule · UN1T Stillorgan" is pinned against the
// installed Next resolver in src/lib/staff-tab-title.test.js.
describe('/schedule root — tab title', () => {
  it('names the page and leaves the studio to the (team) layout template', () => {
    expect(pageModule.metadata).toEqual({ title: 'Schedule' })
  })

  // Next refuses a segment that exports both, and only `next build` says so.
  it('does not also export generateMetadata', () => {
    expect(pageModule.generateMetadata).toBeUndefined()
  })
})
