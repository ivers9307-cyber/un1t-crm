// ROLEUI.1 — /contacts/[id]/edit decides at the CONTACT's location.
//
// The form saves through PUT /api/contacts/[id], which decides MANAGER_ROLES
// at the contact's location (ROLESWEEP.1c/.2). The page used to decide on
// user.role and hasPermission(user, 'contacts'), both the ACTIVE studio's, so
// it opened a form the PUT would refuse (manager at the active studio, staff
// at the contact's) and refused one the PUT would take (the reverse).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { person, MASTER, LOC_A, LOC_B } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url) => {
    const err = new Error(`NEXT_REDIRECT:${url}`)
    err.digest = `NEXT_REDIRECT;${url}`
    throw err
  }),
  notFound: vi.fn(() => {
    const err = new Error('NEXT_NOT_FOUND')
    err.digest = 'NEXT_NOT_FOUND'
    throw err
  }),
}))
vi.mock('@/components/ContactForm', () => ({ default: () => null }))

import EditContactPage from './page.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const CONTACT_ID = 'c0000000-0000-4000-8000-000000000001'
const contactAt = (loc) => ({ id: CONTACT_ID, name: 'Member One', location_id: loc })

// contacts: .select('*').eq('id', id).single()
function mockDb(contact) {
  return {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          single: vi.fn(async () => ({ data: contact, error: contact ? null : { message: 'not found' } })),
        })),
      })),
    })),
  }
}
const props = () => ({ params: Promise.resolve({ id: CONTACT_ID }) })

beforeEach(() => vi.clearAllMocks())

describe('/contacts/[id]/edit', () => {
  it('opens for a manager at the contact\'s studio whose ACTIVE studio is one where they are staff (main: redirected)', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'staff' }, [LOC_B]: { role: 'manager' } }, LOC_A))
    createServerClient.mockReturnValue(mockDb(contactAt(LOC_B)))
    await expect(EditContactPage(props())).resolves.toBeTruthy()
  })

  it('sends a manager at the active studio who is staff at the contact\'s back to the contact (main: opened a form the PUT refuses)', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'manager' }, [LOC_B]: { role: 'staff' } }, LOC_A))
    createServerClient.mockReturnValue(mockDb(contactAt(LOC_B)))
    await expect(EditContactPage(props())).rejects.toThrow(new RegExp(`^NEXT_REDIRECT:/contacts/${CONTACT_ID}$`))
  })

  it('judges the `contacts` permission at the contact\'s studio (main: the active studio\'s)', async () => {
    getCurrentUser.mockResolvedValue(person({
      [LOC_A]: { role: 'manager', permissions: { contacts: true } },
      [LOC_B]: { role: 'manager', permissions: { contacts: false } },
    }, LOC_A))
    createServerClient.mockReturnValue(mockDb(contactAt(LOC_B)))
    await expect(EditContactPage(props())).rejects.toThrow(/^NEXT_REDIRECT:\/$/)
  })

  it('sends a caller who does not belong to the contact\'s studio to the list', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'owner' } }, LOC_A))
    createServerClient.mockReturnValue(mockDb(contactAt(LOC_B)))
    await expect(EditContactPage(props())).rejects.toThrow(/^NEXT_REDIRECT:\/contacts$/)
  })

  it('opens for a master', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    createServerClient.mockReturnValue(mockDb(contactAt(LOC_B)))
    await expect(EditContactPage(props())).resolves.toBeTruthy()
  })

  it('404s a missing contact', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    createServerClient.mockReturnValue(mockDb(null))
    await expect(EditContactPage(props())).rejects.toThrow(/^NEXT_NOT_FOUND$/)
  })

  it('redirects to /login without a session', async () => {
    getCurrentUser.mockResolvedValue(null)
    createServerClient.mockReturnValue(mockDb(contactAt(LOC_B)))
    await expect(EditContactPage(props())).rejects.toThrow(/^NEXT_REDIRECT:\/login$/)
  })
})
