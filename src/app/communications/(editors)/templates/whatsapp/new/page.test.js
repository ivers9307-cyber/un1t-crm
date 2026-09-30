// WATPLROLE.1 — /communications/templates/whatsapp/new. Its only action is
// POST /api/whatsapp/templates, which decides MANAGER_ROLES at the location it
// creates at: the active studio. Anyone else is sent back to the list rather
// than shown a form whose submit is a 403. Ids are synthetic.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/components/WATemplateEditor', () => ({ default: () => null }))
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url) => {
    const err = new Error(`NEXT_REDIRECT:${url}`)
    err.digest = `NEXT_REDIRECT;${url}`
    throw err
  }),
}))

import NewWATemplatePage from './page.js'
import { getCurrentUser } from '@/lib/auth'
import { LOC_A, LOC_B, person, MASTER } from '../../../../../../../tests/helpers/owner-at-location-callers.js'

const BACK = /^NEXT_REDIRECT:\/communications\/templates\?channel=whatsapp$/

beforeEach(() => vi.clearAllMocks())

describe('/communications/templates/whatsapp/new (WATPLROLE.1)', () => {
  it('redirects to /login without a session', async () => {
    getCurrentUser.mockResolvedValue(null)
    await expect(NewWATemplatePage()).rejects.toThrow(/^NEXT_REDIRECT:\/login$/)
  })

  it.each([
    ['staff at the active studio', person({ [LOC_B]: 'staff' }, LOC_B)],
    ['reception at the active studio', person({ [LOC_B]: 'reception' }, LOC_B)],
    ['a manager elsewhere who is staff at the active studio', person({ [LOC_A]: 'manager', [LOC_B]: 'staff' }, LOC_B)],
  ])('%s: sent back to the list', async (_label, caller) => {
    getCurrentUser.mockResolvedValue(caller)
    await expect(NewWATemplatePage()).rejects.toThrow(BACK)
  })

  it.each([
    ['a manager at the active studio', person({ [LOC_B]: 'manager' }, LOC_B)],
    ['a head coach at the active studio', person({ [LOC_B]: 'head_coach' }, LOC_B)],
    ['an owner at the active studio', person({ [LOC_B]: 'owner' }, LOC_B)],
    ['a master', MASTER],
  ])('%s: the editor, at the active studio, with canManage', async (_label, caller) => {
    getCurrentUser.mockResolvedValue(caller)
    const el = await NewWATemplatePage()
    expect(el.props).toMatchObject({ locationId: caller.activeLocation.id, userId: caller.id, canManage: true })
  })
})
