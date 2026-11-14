// APPROVALSQ.3 — the inbox page hands the active studio's zone to UnifiedInbox.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/permissions', () => ({ hasPermission: () => true }))
vi.mock('next/navigation', () => ({ redirect: (u) => { throw new Error(`redirect ${u}`) } }))
vi.mock('@/components/UnifiedInbox', () => ({ default: () => null }))

import InboxPage from './page.js'
import UnifiedInbox from '@/components/UnifiedInbox'
import { getCurrentUser } from '@/lib/auth'

beforeEach(() => vi.clearAllMocks())

describe('/communications/inbox page', () => {
  it('passes the active studio timezone to UnifiedInbox', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', role: 'owner', activeLocation: { id: 'l1', timezone: 'America/New_York' } })
    const el = await InboxPage({ searchParams: Promise.resolve({}) })
    expect(el.type).toBe(UnifiedInbox)
    expect(el.props.timezone).toBe('America/New_York')
  })
  it('passes null when the studio has none', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', role: 'owner', activeLocation: { id: 'l1' } })
    const el = await InboxPage({ searchParams: Promise.resolve({}) })
    expect(el.props.timezone).toBeNull()
  })
})
