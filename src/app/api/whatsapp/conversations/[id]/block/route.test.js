// ROUTEWRAP.R9 — POST /api/whatsapp/conversations/[id]/block on withAuth:
// signed out is withAuth's 401, WhatsApp (web or mobile) is judged at the
// THREAD's studio (INBOXLOC.1), another studio's thread is 404, a caller who
// passes blocks at Meta and mirrors it locally, a no-number refusal stays the
// 409 setup message, and Meta's own error text is logged, never answered.
// Ids and the number are synthetic (the 555 range).
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/whatsapp', () => ({ setWhatsAppUserBlockState: vi.fn(async () => ({})) }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { setWhatsAppUserBlockState } from '@/lib/whatsapp'
import { logError } from '@/lib/log'
import { WhatsAppNumberMissingError, NO_WHATSAPP_NUMBER_MESSAGE } from '@/lib/whatsapp-number-missing'

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'
const CONV = '00000000-0000-4000-8000-0000000000c1'
const CONTACT = '00000000-0000-4000-8000-0000000000c2'
const PHONE = '15555550100'
const ON = { whatsapp: true, mobile: { whatsapp: true } }
const OFF = { whatsapp: false, mobile: { whatsapp: false } }

const caller = (perms) => ({
  id: 'u1', role: 'staff', activeLocation: { id: A, features: {} },
  activeAssignment: { role: 'staff', permissions: perms[A] ?? OFF },
  locations: Object.keys(perms).map((id) => ({ id, role: 'staff', features: {} })),
  assignmentsByLocation: Object.fromEntries(Object.entries(perms).map(([id, p]) => [id, { role: 'staff', permissions: p }])),
  user: { id: 'u1' },
})

let updates
function fakeDb(row) {
  updates = []
  return {
    from: (table) => {
      const b = {
        select: () => b, eq: () => b,
        maybeSingle: async () => ({ data: row, error: null }),
        update: (patch) => { updates.push({ table, patch }); return b },
        then: (ok, bad) => Promise.resolve({ data: null, error: null }).then(ok, bad),
      }
      return b
    },
  }
}

const post = (body) => POST(
  new Request(`http://x/api/whatsapp/conversations/${CONV}/block`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  { params: Promise.resolve({ id: CONV }) },
)

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue(fakeDb({ id: CONV, location_id: B, contact_id: CONTACT, wa_phone: PHONE, is_blocked: false }))
})

describe('POST /api/whatsapp/conversations/[id]/block', () => {
  it('signed out: withAuth\'s 401, nothing sent to Meta', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await post({ action: 'block' })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(setWhatsAppUserBlockState).not.toHaveBeenCalled()
  })

  it('no WhatsApp at the thread\'s studio: 403; another studio\'s thread: 404; nothing sent or written', async () => {
    getCurrentUser.mockResolvedValue(caller({ [A]: ON, [B]: OFF }))
    expect((await post({ action: 'block' })).status).toBe(403)
    getCurrentUser.mockResolvedValue(caller({ [A]: ON }))
    expect((await post({ action: 'block' })).status).toBe(404)
    expect(setWhatsAppUserBlockState).not.toHaveBeenCalled()
    expect(updates).toEqual([])
  })

  it('WhatsApp at the thread\'s studio: blocks at Meta on the thread number and mirrors it', async () => {
    getCurrentUser.mockResolvedValue(caller({ [A]: OFF, [B]: ON }))
    const res = await post({ action: 'block' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { is_blocked: true } })
    expect(setWhatsAppUserBlockState).toHaveBeenCalledWith(PHONE, true, { locationId: B, replyInConversation: CONV })
    expect(updates).toEqual([
      { table: 'whatsapp_conversations', patch: { is_blocked: true } },
      { table: 'contacts', patch: { wa_status: 'blocked' } },
    ])
  })

  it('no number switched on: 409 with the setup message, nothing mirrored', async () => {
    getCurrentUser.mockResolvedValue(caller({ [B]: ON }))
    setWhatsAppUserBlockState.mockRejectedValueOnce(new WhatsAppNumberMissingError(B))
    const res = await post({ action: 'unblock' })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe(NO_WHATSAPP_NUMBER_MESSAGE)
    expect(updates).toEqual([])
  })

  it('a Meta failure: 502 with a fixed line; Meta\'s text is logged, not answered', async () => {
    getCurrentUser.mockResolvedValue(caller({ [B]: ON }))
    setWhatsAppUserBlockState.mockRejectedValueOnce(new Error(`(#100) Invalid parameter for ${PHONE}`))
    const res = await post({ action: 'block' })
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body).toEqual({ success: false, error: 'Meta block call failed' })
    expect(JSON.stringify(body)).not.toContain(PHONE)
    expect(logError).toHaveBeenCalledWith('wa-block', 'Meta block call failed', expect.objectContaining({ conversationId: CONV }))
    expect(updates).toEqual([])
  })
})
