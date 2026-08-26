// CAMPAIGN-RESEND (mig 506) — the unified composer's email entry
// accepts the resend-to-non-openers config and persists it onto the
// campaign row. Marketing stream only (outbound has no open tracking),
// and a wait is required so the spawner has a real deadline.

import { describe, it, expect, vi, beforeEach } from 'vitest'

let inserted = []
const fakeDb = {
  from: () => ({
    insert: (row) => {
      inserted.push(row)
      return {
        select: () => ({
          single: () => Promise.resolve({ data: { id: 'camp-new' }, error: null }),
        }),
      }
    },
  }),
}

vi.mock('@/lib/supabase', () => ({ createServerClient: () => fakeDb }))
vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(async () => ({ id: 'user-1', activeLocation: { id: 'loc-1' } })),
  assertLocationAccess: vi.fn(() => null),
}))
vi.mock('@/lib/permissions', () => ({ hasPermission: vi.fn(() => true) }))

import { POST } from './route.js'

const base = {
  location_id: '00000000-0000-0000-0000-000000000001',
  name: 'Weekend offer',
  subject: 'Last chance',
  html_content: '<html><body>Hi</body></html>',
  action: 'send',
  email_type: 'marketing',
}

function post(body) {
  return POST(new Request('http://test.local/api/communications/email-draft', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

beforeEach(() => {
  vi.clearAllMocks()
  inserted = []
})

describe('email-draft — resend-to-non-openers config', () => {
  it('persists resend fields on a marketing campaign', async () => {
    const res = await post({ ...base, resend_enabled: true, resend_wait_hours: 48, resend_subject: 'Still open?' })
    expect(res.status).toBe(200)
    expect(inserted[0]).toMatchObject({
      resend_enabled: true,
      resend_wait_hours: 48,
      resend_subject: 'Still open?',
    })
  })

  it('a blank resend subject persists as null (reuse the original)', async () => {
    await post({ ...base, resend_enabled: true, resend_wait_hours: 24 })
    expect(inserted[0].resend_enabled).toBe(true)
    expect(inserted[0].resend_subject).toBeNull()
  })

  it('rejects resend on a utility (outbound) send', async () => {
    const res = await post({ ...base, email_type: 'utility', resend_enabled: true, resend_wait_hours: 48 })
    expect(res.status).toBe(400)
    expect(inserted).toHaveLength(0)
    const body = await res.json()
    expect(body.error).toMatch(/marketing/i)
  })

  it('rejects resend without a wait', async () => {
    const res = await post({ ...base, resend_enabled: true })
    expect(res.status).toBe(400)
    expect(inserted).toHaveLength(0)
  })

  it('rejects an out-of-bounds wait via schema validation', async () => {
    const zero = await post({ ...base, resend_enabled: true, resend_wait_hours: 0 })
    expect(zero.status).toBe(400)
    const week2 = await post({ ...base, resend_enabled: true, resend_wait_hours: 300 })
    expect(week2.status).toBe(400)
    expect(inserted).toHaveLength(0)
  })

  // COMMSFIX.D.2d — server backstop. The composer is no longer able to post an
  // empty body (D.2a/b/c), but the route is the last line: nothing may queue or
  // schedule a campaign with no subject or no html_content, whatever the client.
  it.each([
    ['send', undefined],
    ['send', ''],
    ['send', '   '],
    ['schedule', undefined],
    ['schedule', ''],
  ])('rejects action %s with html_content %p', async (action, html_content) => {
    const res = await post({
      ...base, action, html_content,
      ...(action === 'schedule' ? { scheduled_at: '2026-09-01T09:00:00.000Z' } : {}),
    })
    expect(res.status).toBe(400)
    expect(inserted).toHaveLength(0)
    const body = await res.json()
    expect(body.error).toMatch(/body|content/i)
  })

  it.each(['send', 'schedule'])('rejects action %s with no subject', async (action) => {
    const res = await post({
      ...base, action, subject: '   ',
      ...(action === 'schedule' ? { scheduled_at: '2026-09-01T09:00:00.000Z' } : {}),
    })
    expect(res.status).toBe(400)
    expect(inserted).toHaveLength(0)
    const body = await res.json()
    expect(body.error).toMatch(/subject/i)
  })

  it('still allows a draft with no body — that is what a draft is for', async () => {
    const res = await post({ ...base, action: 'draft', html_content: undefined, subject: undefined })
    expect(res.status).toBe(200)
    expect(inserted).toHaveLength(1)
  })

  it('a campaign without resend opts in to nothing', async () => {
    const res = await post(base)
    expect(res.status).toBe(200)
    expect(inserted[0]).not.toHaveProperty('resend_enabled')
    expect(inserted[0]).not.toHaveProperty('resend_wait_hours')
  })
})

// COMMSFIX.B.7 — invalid audience filters are rejected at save time with the
// InvalidAudienceFilterError message, instead of being parked on a campaign
// that can never populate (it would wedge 'queued' forever; the composer
// used to swallow the count-time 400 too).
describe('email-draft — audience filter validated at save time (B7)', () => {
  it('rejects an OR + tag filter with the library message', async () => {
    const res = await post({
      ...base,
      audience_filter: {
        logic: 'or',
        filters: [
          { field: 'tag', op: 'eq', value: 'hot_lead' },
          { field: 'pipeline_stage_slug', op: 'eq', value: 'new_lead' },
        ],
      },
    })
    expect(res.status).toBe(400)
    expect(inserted).toHaveLength(0)
    const body = await res.json()
    expect(body.error).toMatch(/OR logic is not supported together with tag, event or studio-list filters/)
  })

  it('rejects an unknown legacy field', async () => {
    const res = await post({
      ...base,
      audience_filter: { logic: 'and', filters: [{ field: 'lead_status', op: 'eq', value: 'active_trial' }] },
    })
    expect(res.status).toBe(400)
    expect(inserted).toHaveLength(0)
    const body = await res.json()
    expect(body.error).toMatch(/Unknown audience field/)
  })

  it('still accepts a valid filter', async () => {
    const res = await post({
      ...base,
      audience_filter: { logic: 'and', filters: [{ field: 'glofox_membership_type', op: 'neq', value: 'time' }] },
    })
    expect(res.status).toBe(200)
    expect(inserted).toHaveLength(1)
  })
})
