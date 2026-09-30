// PAGEGATES.1 — /contacts/imports/[id] decides at the BATCH's location.
//
// GET /api/contacts/imports/[id] and …/error-csv judge MANAGER_ROLES at the
// batch's location. The page judged user.role (the ACTIVE studio's): a manager
// at the active studio who is staff at the batch's studio got the batch's rows
// (the raw CSV rows, contact details included) rendered server-side and an
// Error rows link that 403s; a manager at the batch's studio who is staff at
// the active one was redirected. An outsider was redirected, not 404'd.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { person, MASTER, OUTSIDER, LOC_A, LOC_B } from '../../../../../../tests/helpers/role-sweep-callers.js'
import { pageDb, navigationMock } from '../../../../../../tests/helpers/page-db-mock.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('next/navigation', () => navigationMock())
vi.mock('@/components/ImportRollbackButton', () => ({ default: () => null }))
vi.mock('@/lib/select-all', () => ({ selectAll: vi.fn(async () => []) }))

import ImportDetailPage from './page.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const IMPORT_ID = 'i0000000-0000-4000-8000-000000000001'
const props = () => ({ params: Promise.resolve({ id: IMPORT_ID }) })
const at = (loc) => createServerClient.mockReturnValue(pageDb({
  contact_imports: {
    id: IMPORT_ID, location_id: loc, status: 'completed', created_at: '2026-09-01T10:00:00Z',
    source_filename: 'members.csv', errored_count: 0, skipped_count: 0, actor: null,
  },
}))
const two = (a, b) => person({ [LOC_A]: { role: a }, [LOC_B]: { role: b } }, LOC_A)

beforeEach(() => vi.clearAllMocks())

describe('/contacts/imports/[id]', () => {
  it('opens for a manager at the batch\'s studio who is staff at the active one (main: redirected)', async () => {
    getCurrentUser.mockResolvedValue(two('staff', 'manager')); at(LOC_B)
    await expect(ImportDetailPage(props())).resolves.toBeTruthy()
  })
  it('refuses a manager at the active studio who is staff at the batch\'s (main: rendered its rows)', async () => {
    getCurrentUser.mockResolvedValue(two('manager', 'staff')); at(LOC_B)
    await expect(ImportDetailPage(props())).rejects.toThrow(/^NEXT_REDIRECT:\/contacts$/)
  })
  it('404s an outsider (main: redirected)', async () => {
    getCurrentUser.mockResolvedValue(OUTSIDER); at(LOC_B)
    await expect(ImportDetailPage(props())).rejects.toThrow(/^NEXT_NOT_FOUND$/)
  })
  it('opens for a master', async () => {
    getCurrentUser.mockResolvedValue(MASTER); at(LOC_B)
    await expect(ImportDetailPage(props())).resolves.toBeTruthy()
  })
})
