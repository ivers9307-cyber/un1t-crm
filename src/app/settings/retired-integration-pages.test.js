// INTEGONE.3 — the three retired pages only redirect into the Integrations
// hub, after the signed-in check (a signed-out caller still goes to /login).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url) => {
    const err = new Error(`NEXT_REDIRECT:${url}`)
    err.digest = `NEXT_REDIRECT;${url}`
    throw err
  }),
  notFound: vi.fn(() => { throw new Error('NEXT_NOT_FOUND') }),
}))

import { getCurrentUser } from '@/lib/auth'
import HealthPage from './integration-health/page.js'
import NumbersPage from './whatsapp-numbers/page.js'
import ZoomPage from './integrations/zoom-contacts/page.js'

const CASES = [
  ['/settings/integration-health', HealthPage, '/settings/integrations-hub?view=health'],
  ['/settings/whatsapp-numbers', NumbersPage, '/settings/integrations-hub?manage=whatsapp-numbers'],
  ['/settings/integrations/zoom-contacts', ZoomPage, '/settings/integrations-hub?view=zoom'],
]

beforeEach(() => vi.clearAllMocks())

describe.each(CASES)('%s', (_path, Page, target) => {
  it('signed out goes to /login first', async () => {
    getCurrentUser.mockResolvedValue(null)
    await expect(Page()).rejects.toThrow(/^NEXT_REDIRECT:\/login$/)
  })

  it('signed in lands on the hub', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1' })
    await expect(Page()).rejects.toThrow(new RegExp(`^NEXT_REDIRECT:${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`))
  })
})
