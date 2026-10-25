// C116 GATES-2 — the /communications layout is the COARSE gate (email,
// whatsapp or email_inbox at SOME studio). It judged the active studio, so it
// bounced a record page judged at the record's studio (a sent broadcast, a
// template of another studio, Mail for every studio) before that page ran.
// Pages with no record carry their own active-studio gate
// (tests/communications-pages-gate.test.js).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { person, LOC_A, LOC_B } from '../../../tests/helpers/role-sweep-callers.js'
import { navigationMock } from '../../../tests/helpers/page-db-mock.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('next/navigation', () => navigationMock())
vi.mock('@/lib/staff-tab-title', () => ({ staffTabMetadata: vi.fn() }))

import CommunicationsLayout from './layout.js'
import { getCurrentUser } from '@/lib/auth'

const off = { email: false, whatsapp: false, email_inbox: false }
beforeEach(() => vi.clearAllMocks())

describe('/communications layout', () => {
  it.each(['email', 'whatsapp', 'email_inbox'])('lets in %s held at another studio only (main: redirected)', async (key) => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'owner', permissions: off }, [LOC_B]: { role: 'owner', permissions: { ...off, [key]: true } } }, LOC_A))
    await expect(CommunicationsLayout({ children: 'x' })).resolves.toBe('x')
  })
  it('redirects someone holding none of them anywhere', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'owner', permissions: off }, [LOC_B]: { role: 'owner', permissions: off } }, LOC_A))
    await expect(CommunicationsLayout({ children: 'x' })).rejects.toThrow(/^NEXT_REDIRECT:\/$/)
  })
})
