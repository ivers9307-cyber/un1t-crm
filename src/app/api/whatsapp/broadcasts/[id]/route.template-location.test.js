// C116 GATES-2 — PUT /api/whatsapp/broadcasts/[id] only accepts a template of
// the broadcast's own studio. The id is caller-supplied; on main any template
// id was written, so another studio's template could be sent to this
// studio's audience.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeDb } from '@/lib/api-auth.test-helpers.js'
import { person, LOC_A, LOC_B } from '../../../../../../tests/helpers/role-sweep-callers.js'

let db
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))

import { PUT } from './route.js'
import { getCurrentUser } from '@/lib/auth'

const BC = '11111111-1111-4111-8111-111111111111'
const TPL_A = '22222222-2222-4222-8222-222222222222'
const TPL_B = '33333333-3333-4333-8333-333333333333'
const put = (body) => PUT(
  new Request('http://localhost/api/x', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  { params: Promise.resolve({ id: BC }) },
)

let tables
beforeEach(() => {
  tables = {
    whatsapp_broadcasts: [{ id: BC, location_id: LOC_A, status: 'draft', scheduled_at: null, template_id: TPL_A }],
    whatsapp_templates: [{ id: TPL_A, location_id: LOC_A }, { id: TPL_B, location_id: LOC_B }],
  }
  db = makeFakeDb(tables)
  // An owner at both studios: the template check is the only thing in the way.
  getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'owner' }, [LOC_B]: { role: 'owner' } }, LOC_A))
})

describe('PUT /api/whatsapp/broadcasts/[id] template_id', () => {
  it("refuses another studio's template, even one the caller can reach (main: 200, written)", async () => {
    const res = await put({ template_id: TPL_B })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Template not found at this location')
    expect(tables.whatsapp_broadcasts[0].template_id).toBe(TPL_A)
  })
  it('refuses a template id that does not exist', async () => {
    const res = await put({ template_id: '44444444-4444-4444-8444-444444444444' })
    expect(res.status).toBe(400)
  })
  it("accepts the broadcast's own studio's template", async () => {
    const res = await put({ template_id: TPL_A, name: 'Spring' })
    expect(res.status).toBe(200)
    expect(tables.whatsapp_broadcasts[0].name).toBe('Spring')
  })
  it('an update without template_id does not read templates', async () => {
    const res = await put({ name: 'Renamed' })
    expect(res.status).toBe(200)
  })
})
