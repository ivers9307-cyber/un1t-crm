// LEAVEBAL.1 — /schedule/leave-balances: the schedule permission plus a
// manager-tier role at the ACTIVE studio (the swaps page pattern).

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal()
  return { ...real, getCurrentUser: vi.fn() }
})

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url) => {
    const err = new Error(`NEXT_REDIRECT:${url}`)
    err.digest = `NEXT_REDIRECT;${url}`
    throw err
  }),
  usePathname: () => '/schedule/leave-balances',
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('@/components/LeaveBalancesManager', () => ({ default: () => <div>leave-balances-stub</div> }))

const { default: LeaveBalancesPage } = await import('./page.js')
const { getCurrentUser } = await import('@/lib/auth')

function user({ role = 'manager', perms = {} } = {}) {
  return {
    id: 'u1',
    role,
    profileRole: role === 'master' ? 'master' : 'staff',
    rolesByLocation: { loc1: role },
    activeAssignment: { permissions: perms },
    activeLocation: { id: 'loc1', features: {} },
    locations: [{ id: 'loc1' }],
  }
}

beforeEach(() => vi.clearAllMocks())

describe('/schedule/leave-balances gate', () => {
  it('redirects to /login without a session', async () => {
    getCurrentUser.mockResolvedValue(null)
    await expect(LeaveBalancesPage()).rejects.toThrow(/^NEXT_REDIRECT:\/login$/)
  })

  it('redirects to / without the schedule permission', async () => {
    getCurrentUser.mockResolvedValue(user({ role: 'staff', perms: { schedule: false } }))
    await expect(LeaveBalancesPage()).rejects.toThrow(/^NEXT_REDIRECT:\/$/)
  })

  it('redirects plain staff to /schedule', async () => {
    getCurrentUser.mockResolvedValue(user({ role: 'staff', perms: { schedule: true } }))
    await expect(LeaveBalancesPage()).rejects.toThrow(/^NEXT_REDIRECT:\/schedule$/)
  })

  it('renders for a manager at the active studio', async () => {
    getCurrentUser.mockResolvedValue(user())
    const html = renderToStaticMarkup(await LeaveBalancesPage())
    expect(html).toContain('leave-balances-stub')
    expect(html).toContain('Leave balances')
  })
})
