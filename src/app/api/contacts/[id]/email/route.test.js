// Route-level tests for POST /api/contacts/[id]/email
// (MOBILE-CONTACT-SEND.1). Hoisted vi.mock for auth / permissions /
// supabase / postmark, then call the handler with a real Request + params.
//
// Coverage:
//   - 401 when no user
//   - 403 when neither web nor mobile `email` permission is held
//   - 404 when the contact doesn't exist
//   - 404 when the contact is in a different location (IDOR)
//   - 400 when the contact has no email
//   - 400 when the contact's email_status is blocked
//   - happy path → sends via Postmark + logs an activity

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccess: (user, locationId) => {
    if (!user) return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 })
    if (!locationId) return null
    const allowed = (user.locations || []).some((l) => l.id === locationId)
    if (!allowed) return new Response(JSON.stringify({ success: false, error: 'Forbidden' }), { status: 403 })
    return null
  },
  assertLocationAccessOr404: (user, locationId) => {
    if (!user) return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 })
    if (!locationId) return null
    const allowed = (user.locations || []).some((l) => l.id === locationId)
    if (!allowed) return new Response(JSON.stringify({ success: false, error: 'Not found' }), { status: 404 })
    return null
  },
}))

vi.mock('@/lib/permissions', () => ({
  hasPermission: vi.fn(() => false),
  hasMobilePermission: vi.fn(() => true),
}))

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

vi.mock('@/lib/postmark', () => ({
  applyMergeTags: (s) => s,
  sendTransactionalEmail: vi.fn(() => Promise.resolve({ messageId: 'pm-1' })),
}))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission, hasMobilePermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { sendTransactionalEmail } from '@/lib/postmark'

function mockDb({ contact, contactError = null, locPref = { email_marketing: true } } = {}) {
  const calls = { activityInsert: [] }
  function from(table) {
    // LOCCOMMS.5 — the consent gate moved off email_status onto the contact's
    // row for its own location. Defaults to opted-in so existing tests keep
    // exercising their original subject.
    if (table === 'contact_location_preferences') {
      const maybeSingle = vi.fn(() => Promise.resolve({ data: locPref, error: null }))
      const eq2 = vi.fn(() => ({ maybeSingle }))
      const eq1 = vi.fn(() => ({ eq: eq2 }))
      const select = vi.fn(() => ({ eq: eq1 }))
      return { select }
    }
    if (table === 'contacts') {
      const single = vi.fn(() => Promise.resolve(contactError ? { data: null, error: contactError } : { data: contact, error: null }))
      const eq = vi.fn(() => ({ single }))
      const select = vi.fn(() => ({ eq }))
      return { select }
    }
    if (table === 'activities') {
      const insert = vi.fn((payload) => { calls.activityInsert.push(payload); return Promise.resolve({ error: null }) })
      return { insert }
    }
    throw new Error(`unexpected table: ${table}`)
  }
  return { from: vi.fn(from), __calls: calls }
}

beforeEach(() => {
  vi.clearAllMocks()
  hasPermission.mockReturnValue(false)
  hasMobilePermission.mockReturnValue(true)
})

function req(body) {
  return new Request('https://example.com/api/contacts/c1/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? { subject: 'Hi', body: 'Hello there' }),
  })
}

const CONTACT = {
  id: 'c1', location_id: 'loc-A', email: 'sarah@example.com', email_status: 'active',
  first_name: 'Sarah', locations: { id: 'loc-A', name: 'Stillorgan' },
}

describe('POST /api/contacts/[id]/email', () => {
  it('returns 401 when no user', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await POST(req(), { params: { id: 'c1' } })
    expect(res.status).toBe(401)
  })

  it('returns 403 when neither web nor mobile email permission is held', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', role: 'staff', locations: [{ id: 'loc-A' }] })
    hasPermission.mockReturnValue(false)
    hasMobilePermission.mockReturnValue(false)
    const res = await POST(req(), { params: { id: 'c1' } })
    expect(res.status).toBe(403)
  })

  it('returns 404 when the contact is not found', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', role: 'manager', locations: [{ id: 'loc-A' }] })
    createServerClient.mockReturnValue(mockDb({ contact: null, contactError: { message: 'nope' } }))
    const res = await POST(req(), { params: { id: 'missing' } })
    expect(res.status).toBe(404)
  })

  it('returns 404 when the contact is in a different location (IDOR)', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', role: 'manager', locations: [{ id: 'loc-A' }] })
    createServerClient.mockReturnValue(mockDb({ contact: { ...CONTACT, location_id: 'loc-B' } }))
    const res = await POST(req(), { params: { id: 'c1' } })
    expect(res.status).toBe(404)
  })

  it('returns 400 when the contact has no email', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', role: 'manager', locations: [{ id: 'loc-A' }] })
    createServerClient.mockReturnValue(mockDb({ contact: { ...CONTACT, email: null } }))
    const res = await POST(req(), { params: { id: 'c1' } })
    expect(res.status).toBe(400)
  })

  it('returns 400 when the email_status is a REPUTATION block', async () => {
    // LOCCOMMS.5 — 'unsubscribed' is no longer an email_status. Reputation
    // states (bounced/complained) are what this gate is for now.
    getCurrentUser.mockResolvedValue({ id: 'u1', role: 'manager', locations: [{ id: 'loc-A' }] })
    createServerClient.mockReturnValue(mockDb({ contact: { ...CONTACT, email_status: 'bounced' } }))
    const res = await POST(req(), { params: { id: 'c1' } })
    expect(res.status).toBe(400)
  })

  it('returns 400 when the contact has opted out at THIS location', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', role: 'manager', locations: [{ id: 'loc-A' }] })
    createServerClient.mockReturnValue(mockDb({ contact: CONTACT, locPref: { email_marketing: false } }))
    const res = await POST(req(), { params: { id: 'c1' } })
    expect(res.status).toBe(400)
  })

  it('returns 400 when the contact is not on this location\u2019s list at all', async () => {
    // Row absent = that location may never send, matching the INNER join in
    // contact_location_audience.
    getCurrentUser.mockResolvedValue({ id: 'u1', role: 'manager', locations: [{ id: 'loc-A' }] })
    createServerClient.mockReturnValue(mockDb({ contact: CONTACT, locPref: null }))
    const res = await POST(req(), { params: { id: 'c1' } })
    expect(res.status).toBe(400)
  })

  it('sends via Postmark and logs an email_sent activity on the happy path', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', role: 'manager', locations: [{ id: 'loc-A' }] })
    const db = mockDb({ contact: CONTACT })
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ subject: 'Class tomorrow', body: 'See you at 9!' }), { params: { id: 'c1' } })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(sendTransactionalEmail).toHaveBeenCalledTimes(1)
    expect(sendTransactionalEmail.mock.calls[0][0]).toMatchObject({
      to: 'sarah@example.com',
      subject: 'Class tomorrow',
      contactId: 'c1',
      locationId: 'loc-A',
    })
    expect(db.__calls.activityInsert).toHaveLength(1)
    expect(db.__calls.activityInsert[0].type).toBe('email_sent')
  })

  it('rejects an empty subject (schema)', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', role: 'manager', locations: [{ id: 'loc-A' }] })
    createServerClient.mockReturnValue(mockDb({ contact: CONTACT }))
    const res = await POST(req({ subject: '', body: 'x' }), { params: { id: 'c1' } })
    expect(res.status).toBe(400)
  })
})
