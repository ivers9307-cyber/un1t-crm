// MEMBERWRITESWEEP.1f — PUT/DELETE /api/admin/tv-displays/[id]/content: push
// something to a TV, or clear it back to idle. They replace the direct
// tv_content upsert/delete from the web TV admin and the staff phone, where
// pushed_by was whatever the client sent and any URL (javascript:, data:)
// reached the public cast page. The server stamps who and when; DECISION 4
// validates what.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }),
  headers: async () => ({ get: () => null }),
}))
let db
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))

import { PUT, DELETE } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import {
  OWNER_A, STAFF_A, MOBILE_ONLY_A, LOC_A, LOC_B, TV_ID, TEMPLATE_ID,
  makeFakeDb, writesOf, jsonRequest, paramsOf, display,
} from '@/lib/tv-admin.test-helpers.js'

const push = (body) => PUT(jsonRequest(`/api/admin/tv-displays/${TV_ID}/content`, 'PUT', body), paramsOf(TV_ID))
const clear = () => DELETE(jsonRequest(`/api/admin/tv-displays/${TV_ID}/content`, 'DELETE'), paramsOf(TV_ID))

function contentDb({ tv = display(), templateLoc = LOC_A, write = (call) => ({ data: { ...call.payload }, error: null }) } = {}) {
  return makeFakeDb((call) => {
    if (call.op === 'select' && call.table === 'tv_displays') return { data: tv, error: null }
    if (call.op === 'select' && call.table === 'tv_templates') return { data: templateLoc ? { location_id: templateLoc } : null, error: null }
    return write(call)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(OWNER_A)
  db = contentDb()
})

describe('PUT /api/admin/tv-displays/[id]/content (push)', () => {
  it('upserts the one content row on tv_display_id, stamping who and when from the session', async () => {
    const res = await push({ source_type: 'url', source_ref: 'https://example.invalid/a.png', label: 'Promo', pushed_by: 'someone-else', triggered_by: 'cron' })
    expect(res.status).toBe(200)
    const [w] = writesOf(db)
    expect(w).toMatchObject({ table: 'tv_content', op: 'upsert', options: { onConflict: 'tv_display_id' } })
    expect(w.payload).toMatchObject({
      tv_display_id: TV_ID, source_type: 'url', source_ref: 'https://example.invalid/a.png', label: 'Promo',
      template_values: null, pushed_by: OWNER_A.id, triggered_by: `manual:${OWNER_A.id}`,
    })
    expect(Number.isNaN(Date.parse(w.payload.pushed_at))).toBe(false)
  })

  it('a photo push in the TV\'s studio folder is stored', async () => {
    expect((await push({ source_type: 'storage', source_ref: `${LOC_A}/1c000000-0000-4000-8000-000000000003.jpg`, label: 'pick.jpg' })).status).toBe(200)
  })

  it('a template push of the same studio keeps its zone values', async () => {
    const values = { z1: { text: 'Hello', fontSize: 6 } }
    expect((await push({ source_type: 'template', source_ref: TEMPLATE_ID, label: 'Board', template_values: values })).status).toBe(200)
    expect(writesOf(db)[0].payload.template_values).toEqual(values)
  })

  it.each([
    ['a javascript: URL', { source_type: 'url', source_ref: 'javascript:alert(1)' }],
    ['a data: URL', { source_type: 'url', source_ref: 'data:text/html,x' }],
    ['a photo from another studio', { source_type: 'storage', source_ref: `${LOC_B}/x.jpg` }],
    ['a template at another studio', { source_type: 'template', source_ref: TEMPLATE_ID, template_values: {} }, LOC_B],
    ['an unknown template', { source_type: 'template', source_ref: TEMPLATE_ID, template_values: {} }, null],
    ['a generated push', { source_type: 'generated', source_ref: 'x' }],
    ['no source_ref', { source_type: 'url' }],
  ])('400 for %s, nothing written', async (_l, body, templateLoc = LOC_A) => {
    db = contentDb({ templateLoc })
    const res = await push(body)
    expect(res.status).toBe(400)
    expect((await res.json()).success).toBe(false)
    expect(writesOf(db)).toEqual([])
  })

  it('a template lookup error is a 500, not a 400', async () => {
    db = makeFakeDb((call) => (call.table === 'tv_templates'
      ? { data: null, error: { message: 'boom' } }
      : { data: display(), error: null }))
    expect((await push({ source_type: 'template', source_ref: TEMPLATE_ID, template_values: {} })).status).toBe(500)
  })

  it('an upsert error is a 500', async () => {
    db = contentDb({ write: () => ({ data: null, error: { message: 'boom' } }) })
    expect((await push({ source_type: 'url', source_ref: 'https://example.invalid/a.png' })).status).toBe(500)
  })

  it('another studio\'s TV: 404, nothing written; plain staff: 403; the mobile toggle alone pushes', async () => {
    db = contentDb({ tv: display({ location_id: LOC_B }) })
    expect((await push({ source_type: 'url', source_ref: 'https://example.invalid/a.png' })).status).toBe(404)
    expect(writesOf(db)).toEqual([])
    db = contentDb()
    getCurrentUser.mockResolvedValue(STAFF_A)
    expect((await push({ source_type: 'url', source_ref: 'https://example.invalid/a.png' })).status).toBe(403)
    getCurrentUser.mockResolvedValue(MOBILE_ONLY_A)
    expect((await push({ source_type: 'url', source_ref: 'https://example.invalid/a.png' })).status).toBe(200)
  })
})

describe('DELETE /api/admin/tv-displays/[id]/content (clear)', () => {
  it('deletes that TV\'s content row', async () => {
    expect((await clear()).status).toBe(200)
    expect(writesOf(db)).toEqual([expect.objectContaining({ table: 'tv_content', op: 'delete', filters: [['eq', 'tv_display_id', TV_ID]] })])
  })

  it('already idle: 200', async () => {
    db = contentDb({ write: () => ({ data: [], error: null }) })
    expect((await clear()).status).toBe(200)
  })

  it('a delete error is a 500', async () => {
    db = contentDb({ write: () => ({ data: null, error: { message: 'boom' } }) })
    expect((await clear()).status).toBe(500)
  })

  it('another studio\'s TV: 404, touches nothing', async () => {
    db = contentDb({ tv: display({ location_id: LOC_B }) })
    expect((await clear()).status).toBe(404)
    expect(writesOf(db)).toEqual([])
  })
})
