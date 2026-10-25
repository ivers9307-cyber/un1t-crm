// PAGEGATES.1 — /presentations/[id]/present decides at the DECK's location.
//
// The remote's only call, POST /api/presentations/[id]/advance, judges
// `presentations` at the deck's location. The page judged it at the ACTIVE
// studio: it refused someone the route serves, and opened a remote whose every
// tap 403'd (silently: the client swallows the failure) for someone without
// the permission at the deck's studio.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { person, MASTER, OUTSIDER, LOC_A, LOC_B } from '../../../../../tests/helpers/role-sweep-callers.js'
import { pageDb, navigationMock } from '../../../../../tests/helpers/page-db-mock.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('next/navigation', () => navigationMock())
vi.mock('./PresenterRemote', () => ({ default: () => null }))

import PresentControlPage from './page.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const DECK_ID = 'd0000000-0000-4000-8000-000000000001'
const props = () => ({ params: Promise.resolve({ id: DECK_ID }) })
const at = (loc) => createServerClient.mockReturnValue(pageDb({
  presentations: { id: DECK_ID, location_id: loc, title: 'Deck', current_index: 0 },
  presentation_slides: [],
}))
const key = (a, b) => person({ [LOC_A]: { role: 'owner', permissions: { presentations: a } }, [LOC_B]: { role: 'owner', permissions: { presentations: b } } }, LOC_A)

beforeEach(() => vi.clearAllMocks())

describe('/presentations/[id]/present', () => {
  it('opens for `presentations` at the deck\'s studio only (main: redirected)', async () => {
    getCurrentUser.mockResolvedValue(key(false, true)); at(LOC_B)
    await expect(PresentControlPage(props())).resolves.toBeTruthy()
  })
  it('refuses `presentations` at the active studio only (main: a remote whose taps 403)', async () => {
    getCurrentUser.mockResolvedValue(key(true, false)); at(LOC_B)
    await expect(PresentControlPage(props())).rejects.toThrow(/^NEXT_REDIRECT:\/$/)
  })
  it('404s an outsider', async () => {
    getCurrentUser.mockResolvedValue(OUTSIDER); at(LOC_B)
    await expect(PresentControlPage(props())).rejects.toThrow(/^NEXT_NOT_FOUND$/)
  })
  it('opens for a master', async () => {
    getCurrentUser.mockResolvedValue(MASTER); at(LOC_B)
    await expect(PresentControlPage(props())).resolves.toBeTruthy()
  })
})
