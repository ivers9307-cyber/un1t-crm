// PAGEGATES.1 — /events/[id]/teams decides at the EVENT's location.
//
// The teams routes (GET/POST /api/events/[id]/teams, export, registrations,
// team members) judge `races` at the event's location; the page judged it at
// the ACTIVE studio and redirected an outsider instead of 404ing.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { person, MASTER, OUTSIDER, LOC_A, LOC_B } from '../../../../../../tests/helpers/role-sweep-callers.js'
import { pageDb, navigationMock } from '../../../../../../tests/helpers/page-db-mock.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('next/navigation', () => navigationMock())
vi.mock('@/components/RaceTeamsManager', () => ({ default: () => null }))

import RaceTeamsPage from './page.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const EVENT_ID = 'e0000000-0000-4000-8000-000000000001'
const props = () => ({ params: Promise.resolve({ id: EVENT_ID }) })
const at = (loc) => createServerClient.mockReturnValue(pageDb({ race_events: { id: EVENT_ID, name: 'Event One', location_id: loc, race_date: '2026-10-01', waves: [] } }))
const races = (a, b) => person({ [LOC_A]: { role: 'owner', permissions: { races: a } }, [LOC_B]: { role: 'owner', permissions: { races: b } } }, LOC_A)

beforeEach(() => vi.clearAllMocks())

describe('/events/[id]/teams', () => {
  it('opens for `races` at the event\'s studio only, active elsewhere (main: redirected)', async () => {
    getCurrentUser.mockResolvedValue(races(false, true)); at(LOC_B)
    await expect(RaceTeamsPage(props())).resolves.toBeTruthy()
  })
  it('refuses `races` at the active studio only (main: rendered a manager every call refuses)', async () => {
    getCurrentUser.mockResolvedValue(races(true, false)); at(LOC_B)
    await expect(RaceTeamsPage(props())).rejects.toThrow(/^NEXT_REDIRECT:\/$/)
  })
  it('404s an outsider (main: redirected)', async () => {
    getCurrentUser.mockResolvedValue(OUTSIDER); at(LOC_B)
    await expect(RaceTeamsPage(props())).rejects.toThrow(/^NEXT_NOT_FOUND$/)
  })
  it('opens for a master', async () => {
    getCurrentUser.mockResolvedValue(MASTER); at(LOC_B)
    await expect(RaceTeamsPage(props())).resolves.toBeTruthy()
  })
})

// C116 GATES-2 — Cancel entry calls POST /api/registrations/[id]/cancel, which
// requires MANAGER_ROLES at the event's studio; the button showed to everyone
// with `races`.
describe('/events/[id]/teams — canCancelEntries at the event\'s studio', () => {
  const rolesAt = (a, b) => person({ [LOC_A]: { role: a, permissions: { races: true } }, [LOC_B]: { role: b, permissions: { races: true } } }, LOC_A)
  it.each([
    ['manager at the event\'s studio, staff at the active one', rolesAt('staff', 'manager'), true],
    ['staff at the event\'s studio, manager at the active one (main: shown, route 403)', rolesAt('manager', 'staff'), false],
    ['head coach at the event\'s studio (MANAGER_ROLES includes head_coach)', rolesAt('owner', 'head_coach'), true],
    ['a master', MASTER, true],
  ])('%s', async (_label, caller, expected) => {
    getCurrentUser.mockResolvedValue(caller); at(LOC_B)
    const el = await RaceTeamsPage(props())
    const manager = el.props.children.find((c) => c?.props?.race)
    expect(manager.props.canCancelEntries).toBe(expected)
  })
})
