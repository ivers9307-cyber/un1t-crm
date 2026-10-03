// C138 (c) — DELETE /api/whatsapp/broadcasts/[id] deleted the recipients, never
// read that delete's error, then deleted the broadcast. Worse, when the
// broadcast delete then failed (whatsapp_messages.broadcast_id has no cascade,
// so any broadcast that sent a message refuses with 23503), the broadcast
// survived with its per-recipient send claims gone, and a re-send went to the
// whole audience again. Now it is ONE statement: the broadcast delete, its
// recipient rows going with it through the FK's ON DELETE CASCADE (mig 007).
// All or nothing. Fictional ids.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { person, LOC_A } from '../../../../../../tests/helpers/role-sweep-callers.js'

let db
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))

import { DELETE } from './route.js'
import { getCurrentUser } from '@/lib/auth'

const BC = '11111111-1111-4111-8111-111111111111'
const del = () => DELETE(new Request('http://localhost/api/x', { method: 'DELETE' }), { params: Promise.resolve({ id: BC }) })

let deletes
let failBroadcast
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
          if (table === 'whatsapp_broadcasts' && failBroadcast) {
            return Promise.resolve({ data: null, error: failBroadcast }).then(ok, bad)
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
  failBroadcast = null
  db = makeDb()
  getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'owner', permissions: { whatsapp: true } } }, LOC_A))
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('DELETE /api/whatsapp/broadcasts/[id] — one atomic delete (C138 c)', () => {
  it('deletes the broadcast only; the recipient rows go with it by cascade, never on their own', async () => {
    const res = await del()
    expect(res.status).toBe(200)
    expect(deletes).toEqual(['whatsapp_broadcasts'])
  })

  it('a broadcast that has sent messages (FK 23503): 409, and the recipients were never touched', async () => {
    failBroadcast = { code: '23503', message: 'violates foreign key constraint' }
    const res = await del()
    expect(res.status).toBe(409)
    expect((await res.json()).success).toBe(false)
    expect(deletes).toEqual([])
  })

  it('any other failed delete: 500, nothing deleted', async () => {
    failBroadcast = { code: 'XX000', message: 'boom' }
    const res = await del()
    expect(res.status).toBe(500)
    expect(deletes).toEqual([])
  })

  it('the cascade it relies on is declared (mig 007)', () => {
    const sql = readFileSync(path.resolve(import.meta.dirname, '../../../../../../supabase/migrations/007_whatsapp_platform.sql'), 'utf8')
    expect(sql).toMatch(/CREATE TABLE[^;]*whatsapp_broadcast_recipients[\s\S]*?broadcast_id UUID NOT NULL REFERENCES whatsapp_broadcasts\(id\) ON DELETE CASCADE/)
  })
})
