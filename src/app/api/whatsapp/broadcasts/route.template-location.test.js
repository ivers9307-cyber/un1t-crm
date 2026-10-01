// C120 GATES-3 (a) — POST /api/whatsapp/broadcasts: a template is sent on its
// OWN studio's number, so a new broadcast may only use a template of the
// studio it is created at (the PUT's GATES-2 rule). The id is caller-supplied.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))

import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { makeFakeDb } from '@/lib/api-auth.test-helpers.js'
import { person, LOC_A, LOC_B } from '../../../../../tests/helpers/role-sweep-callers.js'
import { POST } from './route.js'

const TPL_A = '00000000-0000-4000-8000-0000000000a1'
const TPL_B = '00000000-0000-4000-8000-0000000000b1'
const owner = person({ [LOC_A]: { role: 'owner', permissions: { whatsapp: true } }, [LOC_B]: { role: 'owner', permissions: { whatsapp: true } } }, LOC_A)

const post = (body) => POST(new Request('http://localhost/api/whatsapp/broadcasts', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Spring', audience_filter: { logic: 'and', filters: [] }, location_id: LOC_A, ...body }),
}))

let tables
beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(owner)
  tables = {
    whatsapp_templates: [{ id: TPL_A, location_id: LOC_A }, { id: TPL_B, location_id: LOC_B }],
    whatsapp_broadcasts: [],
  }
  createServerClient.mockReturnValue(makeFakeDb(tables))
})

describe('POST /api/whatsapp/broadcasts — the template must be the studio\'s own', () => {
  it('creates with a template of the same studio', async () => {
    const res = await post({ template_id: TPL_A })
    expect(res.status).toBe(200)
    expect(tables.whatsapp_broadcasts).toHaveLength(1)
  })

  it('refuses another studio\'s template with a 400 and writes nothing', async () => {
    const res = await post({ template_id: TPL_B })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Template not found at this location')
    expect(tables.whatsapp_broadcasts).toHaveLength(0)
  })

  it('refuses an unknown template with a 400', async () => {
    const res = await post({ template_id: '00000000-0000-4000-8000-0000000000ff' })
    expect(res.status).toBe(400)
    expect(tables.whatsapp_broadcasts).toHaveLength(0)
  })

  it('a failed template read is a 500, never a create', async () => {
    const db = makeFakeDb(tables)
    createServerClient.mockReturnValue({
      from: (t) => {
        if (t !== 'whatsapp_templates') return db.from(t)
        const b = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: null, error: { message: 'boom' } }) }
        return b
      },
    })
    const res = await post({ template_id: TPL_A })
    expect(res.status).toBe(500)
    expect(tables.whatsapp_broadcasts).toHaveLength(0)
  })
})
