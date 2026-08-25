// SWAPS.1 — /schedule/swaps only checked login; its siblings (time-off,
// schedule root, expenses, ...) all gate on hasPermission(user, 'schedule').
// Mirrors the /schedule root test pattern (../page.test.js).

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
  usePathname: () => '/schedule/swaps',
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('@/components/SwapRequestsManager', () => ({ default: () => <div>swap-requests-stub</div> }))

import SwapRequestsPage from './page.js'
import { getCurrentUser } from '@/lib/auth'

function user({ role = 'manager', perms = {} } = {}) {
  return {
    id: 'u1',
    role,
    activeAssignment: { permissions: perms },
    activeLocation: { id: 'loc1', features: {} },
  }
}

beforeEach(() => vi.clearAllMocks())

describe('/schedule/swaps gate', () => {
  it('redirects to /login without a session', async () => {
    getCurrentUser.mockResolvedValue(null)
    await expect(SwapRequestsPage()).rejects.toThrow(/^NEXT_REDIRECT:\/login$/)
  })

  it('redirects to / for a user without the schedule permission', async () => {
    getCurrentUser.mockResolvedValue(user({ role: 'staff', perms: { schedule: false } }))
    await expect(SwapRequestsPage()).rejects.toThrow(/^NEXT_REDIRECT:\/$/)
  })

  it('renders for a user with the schedule permission', async () => {
    getCurrentUser.mockResolvedValue(user())
    const html = renderToStaticMarkup(await SwapRequestsPage())
    expect(html).toContain('swap-requests-stub')
  })
})
