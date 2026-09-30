// PAGEGATES.1 — /events/[id]/checkin/scan decides at the EVENT's location.
//
// POST /api/events/[id]/checkin/scan judges `races` at the event's location.
// The page judged it at the ACTIVE studio and never looked at the event, so it
// refused someone the route serves and opened the scanner for a stranger's id.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { person, MASTER, OUTSIDER, LOC_A, LOC_B } from '../../../../../../tests/helpers/role-sweep-callers.js'
import { pageDb, navigationMock } from '../../../../../../tests/helpers/page-db-mock.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('next/navigation', () => navigationMock())
vi.mock('@/components/ScanCheckinClient', () => ({ default: () => null }))

import ScanCheckinPage from './page.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const EVENT_ID = 'e0000000-0000-4000-8000-000000000001'
const props = () => ({ params: Promise.resolve({ id: EVENT_ID }), searchParams: Promise.resolve({ t: 'tok' }) })
const at = (loc) => createServerClient.mockReturnValue(pageDb({ race_events: { id: EVENT_ID, location_id: loc } }))
const races = (a, b) => person({ [LOC_A]: { role: 'owner', permissions: { races: a } }, [LOC_B]: { role: 'owner', permissions: { races: b } } }, LOC_A)

beforeEach(() => vi.clearAllMocks())

describe('/events/[id]/checkin/scan', () => {
  it('opens for `races` at the event\'s studio only, active elsewhere (main: redirected)', async () => {
    getCurrentUser.mockResolvedValue(races(false, true)); at(LOC_B)
    await expect(ScanCheckinPage(props())).resolves.toBeTruthy()
  })
  it('refuses `races` at the active studio only (main: opened a scanner the route refuses)', async () => {
    getCurrentUser.mockResolvedValue(races(true, false)); at(LOC_B)
    await expect(ScanCheckinPage(props())).rejects.toThrow(/^NEXT_REDIRECT:\/$/)
  })
  it('404s an outsider (main: opened)', async () => {
    getCurrentUser.mockResolvedValue(OUTSIDER); at(LOC_B)
    await expect(ScanCheckinPage(props())).rejects.toThrow(/^NEXT_NOT_FOUND$/)
  })
  it('404s a missing event', async () => {
    getCurrentUser.mockResolvedValue(MASTER); createServerClient.mockReturnValue(pageDb({}))
    await expect(ScanCheckinPage(props())).rejects.toThrow(/^NEXT_NOT_FOUND$/)
  })
  it('opens for a master', async () => {
    getCurrentUser.mockResolvedValue(MASTER); at(LOC_B)
    await expect(ScanCheckinPage(props())).resolves.toBeTruthy()
  })
})
