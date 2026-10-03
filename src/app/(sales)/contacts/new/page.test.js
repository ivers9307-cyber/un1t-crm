// ROLEUI.1 — /contacts/new decides at the location the contact is created at.
//
// The form POSTs without a location_id, so POST /api/contacts creates at the
// caller's ACTIVE studio and decides MANAGER_ROLES there, after membership
// (SECFIX.2, ROLESWEEP.2). Here the active studio IS the target, so the page's
// old user.role check gave the same answer in practice; it now asks the
// route's own question of that location, by name, so the rule reads the same
// as every other gate and the repo guard can hold the file to it.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { person, MASTER, LOC_A, LOC_B } from '../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url) => {
    const err = new Error(`NEXT_REDIRECT:${url}`)
    err.digest = `NEXT_REDIRECT;${url}`
    throw err
  }),
}))
vi.mock('@/components/ContactForm', () => ({ default: () => null }))

import NewContactPage from './page.js'
import { getCurrentUser } from '@/lib/auth'

beforeEach(() => vi.clearAllMocks())

describe('/contacts/new', () => {
  it('opens for a manager at the active studio', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'manager' }, [LOC_B]: { role: 'staff' } }, LOC_A))
    await expect(NewContactPage()).resolves.toBeTruthy()
  })

  it('sends staff at the active studio to the list, whatever they are elsewhere (the POST creates at the active studio)', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'manager' }, [LOC_B]: { role: 'staff' } }, LOC_B))
    await expect(NewContactPage()).rejects.toThrow(/^NEXT_REDIRECT:\/contacts$/)
  })

  it('judges `contacts` at the active studio', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'manager', permissions: { contacts: false } } }, LOC_A))
    await expect(NewContactPage()).rejects.toThrow(/^NEXT_REDIRECT:\/$/)
  })

  it('sends a caller with no active studio to the list (the POST would answer 400 location_id required)', async () => {
    const u = person({ [LOC_A]: { role: 'manager' } }, LOC_A)
    getCurrentUser.mockResolvedValue({ ...u, activeLocation: null })
    await expect(NewContactPage()).rejects.toThrow(/^NEXT_REDIRECT:\/contacts$/)
  })

  it('opens for a master', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    await expect(NewContactPage()).resolves.toBeTruthy()
  })
})
