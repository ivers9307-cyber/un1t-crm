// INBOXASSIGN.1 — GET /api/email/mail?owner=mine|unassigned, and the owner's
// name on each row.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/permissions', async () => {
  const actual = await vi.importActual('@/lib/permissions')
  return { ...actual, hasPermissionForLocation: vi.fn(() => true) }
})
vi.mock('./_search', () => ({ searchConversationIds: vi.fn(), SEARCH_SCAN_LIMIT: 1000 }))

import { GET, MAIL_OWNER_FILTERS } from './route'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { makeDb } from '../tickets/_test-db'
import { LOC_A, T_STUDIO, T_ACCOUNTS, OWNER, mailState } from './_test-fixtures'

const COLLEAGUE = 'profile-colleague'

async function list(query) {
  const res = await GET(new Request(`http://x/api/email/mail?location_id=${LOC_A}${query}`))
  return { res, body: await res.json() }
}

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(OWNER)
  const db = makeDb(mailState({
    tickets: [{ ...T_STUDIO, assigned_to: OWNER.id }, { ...T_ACCOUNTS, assigned_to: null }],
    profiles: [{ id: OWNER.id, full_name: 'Olive Owner' }, { id: COLLEAGUE, full_name: 'Alex Example' }],
  }))
  createServerClient.mockImplementation(() => db)
})

describe('mail list owner filter', () => {
  it('knows exactly two filters', () => {
    expect(MAIL_OWNER_FILTERS).toEqual(['mine', 'unassigned'])
  })

  it('no filter lists both, each row carrying its owner name', async () => {
    const { body } = await list('')
    const byId = Object.fromEntries(body.data.conversations.map(c => [c.id, c]))
    expect(Object.keys(byId).sort()).toEqual([T_STUDIO.id, T_ACCOUNTS.id].sort())
    expect(byId[T_STUDIO.id].assignee_name).toBe('Olive Owner')
    expect(byId[T_ACCOUNTS.id].assignee_name).toBe(null)
  })

  it('mine lists only the caller\'s', async () => {
    const { body } = await list('&owner=mine')
    expect(body.data.conversations.map(c => c.id)).toEqual([T_STUDIO.id])
  })

  it('unassigned lists only unowned conversations', async () => {
    const { body } = await list('&owner=unassigned')
    expect(body.data.conversations.map(c => c.id)).toEqual([T_ACCOUNTS.id])
  })

  it('an unknown filter is a 400, never a silent full list', async () => {
    const { res } = await list('&owner=someone')
    expect(res.status).toBe(400)
  })
})
