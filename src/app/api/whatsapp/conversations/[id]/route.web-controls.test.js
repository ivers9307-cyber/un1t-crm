// C126 INBOXCONTROLS.1 — the thread GET follows the PHONE rule (web OR mobile
// `whatsapp` at the thread's studio), but Handled-by (/agent) and add-contact
// (/add-contact) are web-only routes (web `whatsapp` there, INBOXWEBONLY3.1).
// A person with web `whatsapp` at A and only the phone toggle at B could open
// a B thread on the web and press controls that fail. The GET now says
// whether those controls would work: `canUseWebControls`.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))

import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { makeFakeDb } from '@/lib/api-auth.test-helpers.js'
import { person, MASTER, LOC_A, LOC_B } from '../../../../../../tests/helpers/role-sweep-callers.js'
import { GET } from './route.js'

const CONV = '22222222-2222-4222-8222-222222222222'
const get = () => GET(new Request(`http://localhost/api/whatsapp/conversations/${CONV}`), { params: Promise.resolve({ id: CONV }) })

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue(makeFakeDb({
    whatsapp_conversations: [{ id: CONV, location_id: LOC_B, contact_id: null }],
    whatsapp_messages: [],
    locations: [{ id: LOC_B, settings: {} }],
  }))
})

describe('GET /api/whatsapp/conversations/[id] canUseWebControls (C126)', () => {
  it('web whatsapp at the thread\'s studio: true', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'owner', permissions: { whatsapp: false } }, [LOC_B]: { role: 'owner', permissions: { whatsapp: true } } }, LOC_A))
    const res = await get()
    expect(res.status).toBe(200)
    expect((await res.json()).canUseWebControls).toBe(true)
  })

  it('web whatsapp at A, only the phone toggle at B: the thread opens, the controls are off', async () => {
    getCurrentUser.mockResolvedValue(person({
      [LOC_A]: { role: 'manager', permissions: { whatsapp: true } },
      [LOC_B]: { role: 'manager', permissions: { whatsapp: false, mobile: { whatsapp: true } } },
    }, LOC_A))
    const res = await get()
    expect(res.status).toBe(200)
    expect((await res.json()).canUseWebControls).toBe(false)
  })

  it('a master: true', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    expect((await (await get()).json()).canUseWebControls).toBe(true)
  })
})
