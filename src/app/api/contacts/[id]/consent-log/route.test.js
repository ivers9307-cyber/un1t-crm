// Route-level tests for GET /api/contacts/[id]/consent-log.
//
// SECURITY REGRESSION GUARD (H1, 2026-06 platform audit). The route runs
// as service-role (RLS bypassed), so before this fix ANY authenticated
// caller could read ANY contact's GDPR consent history — including
// ip_address and performed_by — just by enumerating contact IDs. These
// tests pin the application-layer gate: resolve the contact's location,
// then assertLocationAccess(). Cross-location callers get 404; a missing
// contact gets 404.
//
// We use the REAL assertLocationAccess — only getCurrentUser + the
// Supabase client are stubbed.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, getCurrentUser: vi.fn() }
})

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { GET } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const LOC_A = 'loc-a'
const LOC_B = 'loc-b'

// ─── DB mock ─────────────────────────────────────────────────────
//
// GET reads:
//   1. from('contacts').select(...).eq('id', x).maybeSingle()
//   2. from('consent_log').select(...).eq('contact_id', x)
//        .order('created_at').order('id').range(from, to)   ← paginated
//
// The mock SERVES the range rather than ignoring it, so a test can hand it
// 2,500 rows and prove the route actually walks past the 1,000-row select cap
// instead of silently returning the first page. `rangeCalls` records the
// windows asked for, which is how we pin the paging itself.
function mockDb({ contact, contactError = null, rows = [], rowsError = null, rangeCalls = [] } = {}) {
  return {
    rangeCalls,
    from: vi.fn((table) => {
      if (table === 'contacts') {
        const maybeSingle = vi.fn(() =>
          Promise.resolve(contactError ? { data: null, error: contactError } : { data: contact, error: null })
        )
        const eq = vi.fn(() => ({ maybeSingle }))
        const select = vi.fn(() => ({ eq }))
        return { select }
      }
      if (table === 'consent_log') {
        const range = vi.fn((from, to) => {
          rangeCalls.push([from, to])
          if (rowsError) return Promise.resolve({ data: null, error: rowsError })
          return Promise.resolve({ data: rows.slice(from, to + 1), error: null })
        })
        const order2 = vi.fn(() => ({ range }))
        const order = vi.fn(() => ({ order: order2, range }))
        const eq = vi.fn(() => ({ order }))
        const select = vi.fn(() => ({ eq }))
        return { select }
      }
      throw new Error(`unexpected table ${table}`)
    }),
  }
}

const userAtA = {
  id: 'u1', isMaster: false, role: 'manager',
  locations: [{ id: LOC_A, name: 'A' }],
}

beforeEach(() => {
  vi.clearAllMocks()
})

const FAKE_REQUEST = new Request('https://example.com/api/contacts/c1/consent-log')

describe('GET /api/contacts/[id]/consent-log', () => {
  it('returns 401 when there is no user', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await GET(FAKE_REQUEST, { params: { id: 'c1' } })
    expect(res.status).toBe(401)
  })

  it('returns 404 when the contact does not exist', async () => {
    getCurrentUser.mockResolvedValue(userAtA)
    createServerClient.mockReturnValue(mockDb({ contact: null }))
    const res = await GET(FAKE_REQUEST, { params: { id: 'missing' } })
    expect(res.status).toBe(404)
  })

  it('returns 404 when the contact is in a location the caller is not assigned to (IDOR)', async () => {
    getCurrentUser.mockResolvedValue(userAtA) // assigned to LOC_A only
    createServerClient.mockReturnValue(mockDb({
      contact: { location_id: LOC_B },                 // contact lives at LOC_B
      rows: [{ id: 'cl1', ip_address: '1.2.3.4' }],    // would leak if not gated
    }))
    const res = await GET(FAKE_REQUEST, { params: { id: 'c1' } })
    const body = await res.json()
    expect(res.status).toBe(404)
    expect(body.success).toBe(false)
    // The consent rows (with ip_address) must NOT be in the response.
    expect(body.rows).toBeUndefined()
  })

  it('returns the consent history when the contact is in the caller’s location', async () => {
    getCurrentUser.mockResolvedValue(userAtA)
    createServerClient.mockReturnValue(mockDb({
      contact: { location_id: LOC_A },
      rows: [
        { id: 'cl1', created_at: '2026-05-01T00:00:00Z', channel: 'email', action: 'opt_in', source: 'form', ip_address: '1.2.3.4', performed_by: null, profiles: null },
      ],
    }))
    const res = await GET(FAKE_REQUEST, { params: { id: 'c1' } })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.rows).toHaveLength(1)
    expect(body.rows[0].ip_address).toBe('1.2.3.4')
  })

  it('lets a master read consent history for any location', async () => {
    // getCurrentUser loads every active location into user.locations for
    // masters, so assertLocationAccess passes naturally.
    getCurrentUser.mockResolvedValue({
      id: 'm1', isMaster: true, role: 'master',
      locations: [{ id: LOC_A }, { id: LOC_B }],
    })
    createServerClient.mockReturnValue(mockDb({
      contact: { location_id: LOC_B },
      rows: [{ id: 'cl1', ip_address: '9.9.9.9', profiles: null }],
    }))
    const res = await GET(FAKE_REQUEST, { params: { id: 'c1' } })
    expect(res.status).toBe(200)
  })
})

// ─── GAPS-P6: the CSV export ──────────────────────────────────────
//
// The export is the subject-access-request tool, so it is bolted onto the
// SAME route and therefore the same location gate — a parallel route would
// have been a second place for the IDOR above to come back. These tests pin
// (a) that the gate really does cover the csv path, (b) that a history
// longer than the 1,000-row select cap comes out whole, and (c) that a
// formula-triggering character cannot reach the file un-neutralised.

const CSV_REQUEST = new Request('https://example.com/api/contacts/c1/consent-log?format=csv')

function consentRow(i, over = {}) {
  return {
    id: `cl${i}`,
    created_at: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
    channel: 'email_marketing',
    action: 'opt_out',
    source: 'one_click_unsubscribe',
    ip_address: null,
    performed_by: null,
    profiles: null,
    location_id: null,
    locations: null,
    ...over,
  }
}

describe('GET /api/contacts/[id]/consent-log?format=csv', () => {
  it('returns 401 with no user — the export is not more public than the feed', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await GET(CSV_REQUEST, { params: { id: 'c1' } })
    expect(res.status).toBe(401)
  })

  it('returns 404 for a contact in another location, and ships no CSV body', async () => {
    getCurrentUser.mockResolvedValue(userAtA)
    createServerClient.mockReturnValue(mockDb({
      contact: { location_id: LOC_B },
      rows: [consentRow(1, { ip_address: '1.2.3.4' })],
    }))
    const res = await GET(CSV_REQUEST, { params: { id: 'c1' } })
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).not.toMatch(/text\/csv/)
    expect(await res.text()).not.toContain('1.2.3.4')
  })

  it('returns 404 for a contact that does not exist', async () => {
    getCurrentUser.mockResolvedValue(userAtA)
    createServerClient.mockReturnValue(mockDb({ contact: null }))
    const res = await GET(CSV_REQUEST, { params: { id: 'nope' } })
    expect(res.status).toBe(404)
  })

  it('serves a CSV download with the contact-named attachment filename', async () => {
    getCurrentUser.mockResolvedValue(userAtA)
    createServerClient.mockReturnValue(mockDb({
      contact: { location_id: LOC_A, first_name: 'Ada', last_name: 'Lovelace' },
      rows: [consentRow(1, {
        profiles: { full_name: 'Sam Staff', email: 'sam@un1t.com' },
        locations: { name: 'Stillorgan' },
      })],
    }))
    const res = await GET(CSV_REQUEST, { params: { id: 'c1' } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/csv/)
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="consent-log-ada-lovelace.csv"')
    const body = await res.text()
    expect(body).toContain('recorded_at,channel,action,source,location,performed_by_name,performed_by_email,ip_address')
    expect(body).toContain('Sam Staff')
    expect(body).toContain('Stillorgan')
    expect(body).toContain('one_click_unsubscribe')
  })

  it('paginates past the 1,000-row select cap instead of truncating the evidence', async () => {
    const rangeCalls = []
    getCurrentUser.mockResolvedValue(userAtA)
    createServerClient.mockReturnValue(mockDb({
      contact: { location_id: LOC_A, first_name: 'Ada', last_name: 'Lovelace' },
      rows: Array.from({ length: 2500 }, (_, i) => consentRow(i)),
      rangeCalls,
    }))
    const res = await GET(CSV_REQUEST, { params: { id: 'c1' } })
    const body = await res.text()
    // header + 2500 data rows (trailing EOL leaves an empty final element).
    expect(body.split('\r\n').filter((l) => l !== '')).toHaveLength(2501)
    expect(rangeCalls.slice(0, 3)).toEqual([[0, 999], [1000, 1999], [2000, 2999]])
  })

  it('normalises a legacy opted_out row so the export cannot lose a withdrawal', async () => {
    getCurrentUser.mockResolvedValue(userAtA)
    createServerClient.mockReturnValue(mockDb({
      contact: { location_id: LOC_A, first_name: 'Ada', last_name: 'Lovelace' },
      rows: [consentRow(1, { action: 'opted_out', source: 'whatsapp_keyword' })],
    }))
    const res = await GET(CSV_REQUEST, { params: { id: 'c1' } })
    const body = await res.text()
    expect(body).toContain(',opt_out,whatsapp_keyword,')
    expect(body).not.toContain('opted_out')
  })

  it('neutralises a formula-triggering staff name before it reaches the file', async () => {
    getCurrentUser.mockResolvedValue(userAtA)
    createServerClient.mockReturnValue(mockDb({
      contact: { location_id: LOC_A, first_name: 'Ada', last_name: 'Lovelace' },
      rows: [consentRow(1, { profiles: { full_name: '=cmd|calc!A1', email: 'x@y.com' } })],
    }))
    const res = await GET(CSV_REQUEST, { params: { id: 'c1' } })
    const body = await res.text()
    expect(body).toContain("'=cmd|calc!A1")
    expect(body).not.toMatch(/(^|,)=cmd/m)
  })

  it('leads with a UTF-8 BOM so Excel does not mangle accented names', async () => {
    getCurrentUser.mockResolvedValue(userAtA)
    createServerClient.mockReturnValue(mockDb({
      contact: { location_id: LOC_A, first_name: 'Aoífe', last_name: 'Ní Bhriain' },
      rows: [consentRow(1)],
    }))
    const res = await GET(CSV_REQUEST, { params: { id: 'c1' } })
    // Asserted on the BYTES, not res.text(): the WHATWG "UTF-8 decode" that
    // backs Response.text() strips a leading BOM, so a text assertion here
    // can never fail and would be a decorative test. The bytes are what
    // Excel actually reads.
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf])
  })

  it('fails loudly rather than shipping a half-built export when a page errors', async () => {
    getCurrentUser.mockResolvedValue(userAtA)
    createServerClient.mockReturnValue(mockDb({
      contact: { location_id: LOC_A, first_name: 'Ada', last_name: 'Lovelace' },
      rowsError: { message: 'boom' },
    }))
    const res = await GET(CSV_REQUEST, { params: { id: 'c1' } })
    expect(res.status).toBe(500)
    expect(res.headers.get('content-type')).not.toMatch(/text\/csv/)
  })

  it('ignores an unknown format and serves the JSON feed', async () => {
    getCurrentUser.mockResolvedValue(userAtA)
    createServerClient.mockReturnValue(mockDb({
      contact: { location_id: LOC_A },
      rows: [consentRow(1)],
    }))
    const req = new Request('https://example.com/api/contacts/c1/consent-log?format=pdf')
    const res = await GET(req, { params: { id: 'c1' } })
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
  })
})

describe('the JSON feed keeps working after the paging refactor', () => {
  it('caps at 500 and reports truncation honestly', async () => {
    getCurrentUser.mockResolvedValue(userAtA)
    createServerClient.mockReturnValue(mockDb({
      contact: { location_id: LOC_A },
      rows: Array.from({ length: 900 }, (_, i) => consentRow(i)),
    }))
    const res = await GET(FAKE_REQUEST, { params: { id: 'c1' } })
    const body = await res.json()
    expect(body.rows).toHaveLength(500)
    expect(body.truncated).toBe(true)
  })

  it('normalises the legacy spelling on the feed too', async () => {
    getCurrentUser.mockResolvedValue(userAtA)
    createServerClient.mockReturnValue(mockDb({
      contact: { location_id: LOC_A },
      rows: [consentRow(1, { action: 'opted_in' })],
    }))
    const res = await GET(FAKE_REQUEST, { params: { id: 'c1' } })
    const body = await res.json()
    expect(body.rows[0].action).toBe('opt_in')
  })
})
