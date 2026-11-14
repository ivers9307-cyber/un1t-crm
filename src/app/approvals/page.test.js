// APPROVALSQ.3 — /approvals hands the active studio's zone to the inbox, so
// its cards show the studio's clock. Drop the prop and the cards fall back to
// the platform zone without any error.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/permissions', () => ({ hasPermission: () => true }))
vi.mock('next/navigation', () => ({ redirect: (u) => { throw new Error(`redirect ${u}`) } }))
vi.mock('@/components/ApprovalsInbox', () => ({ default: () => null }))

import ApprovalsPage from './page.js'
import ApprovalsInbox from '@/components/ApprovalsInbox'
import { getCurrentUser } from '@/lib/auth'

const findInbox = (el) => {
  if (!el || typeof el !== 'object') return null
  if (el.type === ApprovalsInbox) return el
  for (const k of [].concat(el.props?.children ?? [])) {
    const f = findInbox(k)
    if (f) return f
  }
  return null
}

beforeEach(() => vi.clearAllMocks())

describe('/approvals page', () => {
  it('passes the active studio timezone to ApprovalsInbox', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', activeLocation: { id: 'l1', timezone: 'America/New_York' } })
    expect(findInbox(await ApprovalsPage()).props.timezone).toBe('America/New_York')
  })
  it('passes null when the studio has none', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', activeLocation: { id: 'l1' } })
    expect(findInbox(await ApprovalsPage()).props.timezone).toBeNull()
  })
})
