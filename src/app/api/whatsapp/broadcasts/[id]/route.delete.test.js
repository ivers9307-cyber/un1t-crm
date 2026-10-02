// C138 (c) — DELETE /api/whatsapp/broadcasts/[id] deleted the recipients and
// never read that delete's error, then deleted the broadcast anyway. A failed
// recipients delete now fails the request (500) and the broadcast row stays:
// no half-deleted broadcast. Fictional ids.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { person, LOC_A } from '../../../../../../tests/helpers/role-sweep-callers.js'

let db
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))

import { DELETE } from './route.js'
import { getCurrentUser } from '@/lib/auth'

const BC = '11111111-1111-4111-8111-111111111111'
const del = () => DELETE(new Request('http://localhost/api/x', { method: 'DELETE' }), { params: Promise.resolve({ id: BC }) })

let deletes
let failRecipients
function makeDb() {
  return {
    from(table) {
      const b = {}
      let isDelete = false
      b.select = () => b
      b.eq = () => b
      b.single = async () => ({ data: { location_id: LOC_A, status: 'draft', scheduled_at: null }, error: null })
      b.delete = () => { isDelete = true; return b }
      b.then = (ok, bad) => {
        if (isDelete) {
          if (table === 'whatsapp_broadcast_recipients' && failRecipients) {
            return Promise.resolve({ data: null, error: { message: 'boom' } }).then(ok, bad)
          }
          deletes.push(table)
        }
        return Promise.resolve({ data: null, error: null }).then(ok, bad)
      }
      return b
    },
  }
}

beforeEach(() => {
  deletes = []
  failRecipients = false
  db = makeDb()
  getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'owner', permissions: { whatsapp: true } } }, LOC_A))
})

describe('DELETE /api/whatsapp/broadcasts/[id] — the recipients delete is read (C138 c)', () => {
  it('a failed recipients delete: 500 and the broadcast is NOT deleted (main: 200, deleted)', async () => {
    failRecipients = true
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await del()
    expect(res.status).toBe(500)
    expect((await res.json()).success).toBe(false)
    expect(deletes).not.toContain('whatsapp_broadcasts')
  })

  it('both deletes succeed: 200, recipients first then the broadcast', async () => {
    const res = await del()
    expect(res.status).toBe(200)
    expect(deletes).toEqual(['whatsapp_broadcast_recipients', 'whatsapp_broadcasts'])
  })
})
