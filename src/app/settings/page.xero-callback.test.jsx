// CHANNELREAD.1 — /settings is the Xero OAuth callback's fallback landing
// page (a state it could not use carries no location), so the outcome notice
// is mounted here too. The notice itself is tested in
// src/components/settings/XeroCallbackNotice.test.jsx; this pins the mount.

import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(async () => ({ id: 'u1', role: 'master', isMaster: true })) }))
vi.mock('@/lib/permissions', () => ({ hasPermission: () => true }))
vi.mock('next/navigation', () => ({ redirect: vi.fn() }))
vi.mock('next/link', () => ({ default: ({ href, children }) => <a href={href}>{children}</a> }))
vi.mock('@/lib/settings-tree', () => ({ visibleSettingsTree: () => [] }))
vi.mock('@/lib/staff-tombstone', () => ({ excludeTombstones: (q) => q }))
vi.mock('@/components/settings/XeroCallbackNotice', () => ({ default: () => 'XERO_CALLBACK_NOTICE' }))
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    from: () => {
      const q = {
        select: () => q,
        eq: () => q,
        order: () => Promise.resolve({ data: [], error: null }),
        then: (res) => res({ count: 0, error: null }),
      }
      return q
    },
  }),
}))

import SettingsPage from './page.js'

describe('/settings', () => {
  it('mounts the Xero callback notice', async () => {
    const html = renderToStaticMarkup(await SettingsPage())
    expect(html).toContain('XERO_CALLBACK_NOTICE')
  })
})
