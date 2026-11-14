// STAFFCONSENT.1 — the GET lists each studio list with whether the viewer may switch it.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => ({
  ...(await vi.importActual('@/lib/role-at-location')),
  getCurrentUser: vi.fn(),
  assertLocationAccessOr404: vi.fn(() => null),
}))

import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { GET } from './route.js'

const STILL = 'loc-still'
const HATCH = 'loc-hatch'
const OTHER = 'loc-other-org'

function makeDb({ rows, rowsError = null }) {
  return {
    from(table) {
      const b = {
        select() { return b },
        eq() { return b },
        maybeSingle: async () => ({
          data: table === 'contacts' ? { location_id: STILL }
            : table === 'locations' ? { organization_id: 'org-1' }
              : table === 'contact_preferences' ? { email_marketing: true } : null,
          error: null,
        }),
        then(res, rej) { return Promise.resolve({ data: rows, error: rowsError }).then(res, rej) },
      }
      return b
    },
  }
}

const props = { params: Promise.resolve({ id: 'c1' }) }
const ROWS = [
  { location_id: STILL, email_marketing: false, locations: { name: 'Stillorgan', organization_id: 'org-1' } },
  { location_id: HATCH, email_marketing: true, locations: { name: 'Hatch Street', organization_id: 'org-1' } },
  { location_id: OTHER, email_marketing: true, locations: { name: 'Elsewhere', organization_id: 'org-2' } },
]

beforeEach(() => { vi.clearAllMocks() })

describe('GET marketing-preferences studios', () => {
  it('lists the organisation studios, sorted, with can_edit per studio', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', isMaster: false, rolesByLocation: { [STILL]: 'owner', [HATCH]: 'staff' } })
    createServerClient.mockReturnValue(makeDb({ rows: ROWS }))
    const json = await (await GET(new Request('https://x'), props)).json()
    expect(json.preferences.email_marketing).toBe(true)
    expect(json.studios_error).toBe(false)
    expect(json.studios).toEqual([
      { location_id: HATCH, name: 'Hatch Street', email_marketing: true, can_edit: false },
      { location_id: STILL, name: 'Stillorgan', email_marketing: false, can_edit: true },
    ])
  })

  it('a failed read is an empty list with the error flag', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', isMaster: false, rolesByLocation: { [STILL]: 'owner' } })
    createServerClient.mockReturnValue(makeDb({ rows: null, rowsError: { message: 'down' } }))
    const json = await (await GET(new Request('https://x'), props)).json()
    expect(json.studios).toEqual([])
    expect(json.studios_error).toBe(true)
  })
})
