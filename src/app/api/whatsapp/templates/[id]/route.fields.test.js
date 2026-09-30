// WATPLPUT.1 — PUT /api/whatsapp/templates/[id] no longer writes Meta's fields.
//
// It accepted `status`, so a manager could mark a REJECTED template APPROVED
// locally: every picker then offered it and every send failed at Meta. And it
// let a manager rewrite the name, category or components of a template Meta
// had already approved, so the row said one thing and Meta held another.
// After: the Meta-owned fields are refused in every state (400), a submitted
// template's content is refused (409, "use Edit & resubmit"), a draft's
// content still saves, and display_group saves in every state. The header
// image of an APPROVED template can still be replaced (sends attach it as a
// link, no Meta review), but not removed. Ids are synthetic.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/whatsapp', () => ({ deleteTemplate: vi.fn() }))
vi.mock('@/lib/whatsapp-config', () => ({ getLocationWhatsAppNumberConfig: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { PUT } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { LOC_B, person, MASTER } from '../../../../../../tests/helpers/owner-at-location-callers.js'

const MANAGER = person({ [LOC_B]: 'manager' }, LOC_B)
const STAFF = person({ [LOC_B]: 'staff' }, LOC_B)
const APPROVED = { id: 't1', name: 'promo_x', location_id: LOC_B, status: 'APPROVED', meta_template_id: 'meta-1', display_group: null }
const REJECTED = { ...APPROVED, status: 'REJECTED' }
const PENDING = { ...APPROVED, status: 'PENDING' }
const PAUSED = { ...APPROVED, status: 'PAUSED' }
const DRAFT = { ...APPROVED, status: 'draft', meta_template_id: null }

// Reads answer `row`; an update is recorded (and echoed back merged).
function makeDb(row) {
  const writes = []
  return {
    writes,
    from: (table) => {
      let op = 'read'
      let patch
      const b = {
        select: () => b,
        update: (p) => { op = 'update'; patch = p; return b },
        eq: (col, val) => { if (op !== 'read') writes.push({ table, op, patch, where: [col, val] }); return b },
        single: async () => ({ data: op === 'update' ? { ...row, ...patch } : row, error: null }),
      }
      return b
    },
  }
}

const ctx = { params: Promise.resolve({ id: 't1' }) }
const put = (body) => PUT(new Request('https://crm.test/api/whatsapp/templates/t1', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}), ctx)

let db
function withRow(row) { db = makeDb(row); createServerClient.mockReturnValue(db) }
beforeEach(() => { vi.clearAllMocks() })

describe('PUT refuses the fields Meta owns, in every state (WATPLPUT.1)', () => {
  it.each([
    ['a manager marks a REJECTED template APPROVED', MANAGER, REJECTED, { status: 'APPROVED' }],
    ['a master marks a PENDING template APPROVED', MASTER, PENDING, { status: 'APPROVED' }],
    ['a manager sets status on a draft', MANAGER, DRAFT, { status: 'APPROVED' }],
    ['a manager clears a rejection reason', MANAGER, REJECTED, { rejection_reason: null }],
    ['a manager sets the quality rating', MANAGER, APPROVED, { quality_rating: 'GREEN' }],
    ['a manager rewrites the Meta id', MANAGER, APPROVED, { meta_template_id: 'meta-2' }],
    ['staff pair status with a grouping edit', STAFF, APPROVED, { status: 'APPROVED', display_group: 'Offers' }],
    ['a manager pairs status with a new header image', MANAGER, APPROVED, { status: 'APPROVED', header_media_url: 'https://example.test/new.jpg' }],
  ])('%s: 400 naming the field, nothing written', async (_label, caller, row, body) => {
    getCurrentUser.mockResolvedValue(caller)
    withRow(row)
    const res = await put(body)
    const json = await res.json()
    expect(res.status).toBe(400)
    expect(json.success).toBe(false)
    const field = Object.keys(body).find((k) => !['display_group', 'header_media_url'].includes(k))
    expect(json.issues.map((i) => i.path)).toContain(field)
    expect(json.issues.find((i) => i.path === field).message).toMatch(/set by Meta/)
    expect(db.writes).toEqual([])
  })
})

describe('PUT refuses a submitted template\'s content (WATPLPUT.1)', () => {
  it.each([
    ['APPROVED', APPROVED, { components: [{ type: 'BODY', text: 'Changed' }] }, ['components']],
    ['APPROVED', APPROVED, { name: 'promo_y', category: 'UTILITY' }, ['name', 'category']],
    ['APPROVED, content alongside a new header image', APPROVED, { components: [], header_media_url: 'https://example.test/other.jpg' }, ['components']],
    ['PENDING (in review)', PENDING, { header_media_url: 'https://example.test/other.jpg' }, ['header_media_url']],
    ['PENDING', PENDING, { example_values: { 1: 'Sam' } }, ['example_values']],
    ['REJECTED (resubmit is the path)', REJECTED, { components: [] }, ['components']],
    ['PAUSED (resubmit is the path)', PAUSED, { header_media_handle: 'h:abc', header_media_path: 'p' }, ['header_media_handle', 'header_media_path']],
    ['APPROVED, content alongside a grouping edit', APPROVED, { display_group: 'Offers', category: 'UTILITY' }, ['category']],
  ])('%s: 409 naming the locked fields, nothing written', async (_label, row, body, locked) => {
    getCurrentUser.mockResolvedValue(MANAGER)
    withRow(row)
    const res = await put(body)
    const json = await res.json()
    expect(res.status).toBe(409)
    expect(json.success).toBe(false)
    expect(json.error).toMatch(/Edit & resubmit/)
    expect(json.issues.map((i) => i.path)).toEqual(locked)
    expect(db.writes).toEqual([])
  })

  it('APPROVED, a manager removes the header image: 409 (every send attaches it), nothing written', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    withRow(APPROVED)
    const res = await put({ header_media_url: null, header_media_path: null, header_media_handle: null })
    const json = await res.json()
    expect(res.status).toBe(409)
    expect(json.error).toMatch(/replaced, not removed/)
    expect(json.issues).toEqual([{ path: 'header_media_url', message: expect.stringMatching(/replaced, not removed/) }])
    expect(db.writes).toEqual([])
  })

  it('staff sending content to a submitted template still get the role 403 first', async () => {
    getCurrentUser.mockResolvedValue(STAFF)
    withRow(APPROVED)
    const res = await put({ components: [] })
    expect({ status: res.status, body: await res.json() }).toEqual({ status: 403, body: { success: false, error: 'Forbidden' } })
    expect(db.writes).toEqual([])
  })
})

describe('what still saves (WATPLPUT.1)', () => {
  it.each([['APPROVED', APPROVED], ['PENDING', PENDING], ['REJECTED', REJECTED], ['draft', DRAFT]])(
    'display_group on a %s template, staff there: 200', async (_label, row) => {
      getCurrentUser.mockResolvedValue(STAFF)
      withRow(row)
      const res = await put({ display_group: ' Offers ' })
      expect(res.status).toBe(200)
      expect(db.writes).toEqual([{ table: 'whatsapp_templates', op: 'update', patch: { display_group: 'Offers' }, where: ['id', 't1'] }])
    })

  it('a new header image on an APPROVED template, a manager: 200, exactly the three header fields', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    withRow(APPROVED)
    const body = { header_media_handle: 'h:new', header_media_url: 'https://example.test/new.jpg', header_media_path: `${LOC_B}/new.jpg` }
    const res = await put(body)
    expect(res.status).toBe(200)
    expect(db.writes).toEqual([{ table: 'whatsapp_templates', op: 'update', patch: body, where: ['id', 't1'] }])
  })

  it('a new header image on an APPROVED template, staff: the role 403, nothing written', async () => {
    getCurrentUser.mockResolvedValue(STAFF)
    withRow(APPROVED)
    const res = await put({ header_media_url: 'https://example.test/new.jpg' })
    expect(res.status).toBe(403)
    expect(db.writes).toEqual([])
  })

  it('a draft\'s content, a manager: 200, exactly the fields sent', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    withRow(DRAFT)
    const body = {
      name: 'promo_y', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hi {{1}}' }],
      example_values: { 1: 'Sam' }, header_media_url: 'https://example.test/pic.jpg', display_group: 'Offers',
    }
    const res = await put(body)
    expect(res.status).toBe(200)
    expect(db.writes).toEqual([{ table: 'whatsapp_templates', op: 'update', patch: body, where: ['id', 't1'] }])
  })

  it('the editor\'s draft payload (it also sends language, parameter_format, location_id, created_by): 200, those four are dropped as before', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    withRow(DRAFT)
    const res = await put({
      name: 'promo_y', category: 'MARKETING', language: 'en', components: [], parameter_format: 'POSITIONAL',
      location_id: LOC_B, created_by: 'u-synth', header_media_handle: null, header_media_url: null, header_media_path: null, display_group: null,
    })
    expect(res.status).toBe(200)
    expect(Object.keys(db.writes[0].patch).sort()).toEqual(
      ['category', 'components', 'display_group', 'header_media_handle', 'header_media_path', 'header_media_url', 'name'])
  })
})
