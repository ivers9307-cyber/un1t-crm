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

import SchedulePage from './page.js'
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
