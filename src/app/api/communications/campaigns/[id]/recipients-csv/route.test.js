// EXPORTCSV.1 — recipient CSV, through the real withAuth wrapper.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { GET } = await import('./route.js')

const CAMP_A = 'ca000000-0000-4000-8000-00000000000a'
const CAMP_B = 'ca000000-0000-4000-8000-00000000000b'
const EMAIL_A = person({ [LOC_A]: { role: 'manager', permissions: { email: true } } }, LOC_A)
const call = (id) => GET(new Request(`http://localhost/api/communications/campaigns/${id}/recipients-csv`), { params: Promise.resolve({ id }) })

let db
beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: {
    campaigns: [{ id: CAMP_A, name: 'Black Friday!', location_id: LOC_A }, { id: CAMP_B, name: 'Other', location_id: LOC_B }],
    contacts: [{ id: 'c1', name: '=cmd()', email: 'a@example.ie' }],
    campaign_recipients: [{ id: 'r1', campaign_id: CAMP_A, contact_id: 'c1', status: 'clicked', sent_at: '2026-11-20T10:00:00Z', clicked_at: '2026-11-20T11:00:00Z' }],
  } })
  createServerClient.mockReturnValue(db)
  getCurrentUser.mockResolvedValue(EMAIL_A)
})

describe('GET …/recipients-csv', () => {
  it('returns a CSV with a header and one row per recipient, formula-safe', async () => {
    const res = await call(CAMP_A)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/csv/)
    expect(res.headers.get('content-disposition')).toMatch(/Black Friday recipients\.csv/)
    const lines = (await res.text()).trim().split('\r\n')
    expect(lines[0]).toBe('Name,Email,Status,Sent,Delivered,Opened,Clicked,Bounced,Bounce type,Unsubscribed')
    expect(lines[1].startsWith("'=cmd()")).toBe(true)
    expect(lines[1]).toContain('a@example.ie,clicked')
  })

  it("404s for another studio's campaign", async () => {
    expect((await call(CAMP_B)).status).toBe(404)
  })
})
