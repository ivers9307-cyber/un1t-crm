// C116 GATES-2 — the /cars layout is the COARSE gate: `car_processing` at
// SOME studio. It judged the active studio, so it bounced someone opening a
// car at a studio where they hold the key (GATES-1 made /cars/[id] judge the
// car's studio) because their active studio did not. The list pages
// (active, completed, reports) gate at the active studio themselves.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { person, LOC_A, LOC_B } from '../../../tests/helpers/role-sweep-callers.js'
import { navigationMock } from '../../../tests/helpers/page-db-mock.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('next/navigation', () => navigationMock())
vi.mock('@/components/cars/CarTabs', () => ({ default: () => null }))
vi.mock('@/lib/staff-tab-title', () => ({ staffTabMetadata: vi.fn() }))

import CarsLayout from './layout.js'
import ActivePage from './active/page.js'
import { getCurrentUser } from '@/lib/auth'

const key = (a, b) => person({ [LOC_A]: { role: 'owner', permissions: { car_processing: a } }, [LOC_B]: { role: 'owner', permissions: { car_processing: b } } }, LOC_A)

beforeEach(() => vi.clearAllMocks())

describe('/cars layout', () => {
  it('lets in `car_processing` held at another studio only (main: redirected)', async () => {
    getCurrentUser.mockResolvedValue(key(false, true))
    await expect(CarsLayout({ children: null })).resolves.toBeTruthy()
  })
  it('redirects `car_processing` held nowhere', async () => {
    getCurrentUser.mockResolvedValue(key(false, false))
    await expect(CarsLayout({ children: null })).rejects.toThrow(/^NEXT_REDIRECT:\/$/)
  })
  it('the active-studio list page still refuses it (unchanged)', async () => {
    getCurrentUser.mockResolvedValue(key(false, true))
    await expect(ActivePage()).rejects.toThrow(/^NEXT_REDIRECT:\/$/)
  })
})
