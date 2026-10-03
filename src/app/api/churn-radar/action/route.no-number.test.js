// WACONFIGFALLBACK.1 — the churn and lead radars' WhatsApp actions at a
// location with no WhatsApp number of its own. They used to send on the
// global env number (another studio's). Now the resolver refuses: 409 with
// its message (the win-back used to blame the member's message window), and
// no radar action row is written. Ids are synthetic.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(async () => ({ id: 'user-1', activeLocation: { id: 'loc-1' } })) }))
vi.mock('@/lib/permissions', () => ({ hasPermission: vi.fn(() => true) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/whatsapp', () => ({ sendTextMessage: vi.fn() }))
vi.mock('@/lib/radar-outreach', () => ({ sendRadarOutreach: vi.fn() }))
vi.mock('@/lib/sequences', () => ({ enrolContacts: vi.fn() }))
vi.mock('@/lib/dunning-payment', () => ({ capturePaymentForRun: vi.fn(), refreshActiveRunPayment: vi.fn() }))
vi.mock('@/lib/churn-radar', () => ({ paymentTroubleKind: vi.fn(() => 'overdue') }))
vi.mock('@/lib/radar-cache', () => ({ invalidateRadar: vi.fn() }))
vi.mock('@/lib/location-branding', () => ({ getLocationBranding: vi.fn(async () => ({ companyName: 'Studio' })) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))

import { POST as churnPOST } from './route.js'
import { POST as leadPOST } from '../../lead-radar/action/route.js'
import { sendTextMessage } from '@/lib/whatsapp'
import { sendRadarOutreach } from '@/lib/radar-outreach'
import { WhatsAppNumberMissingError } from '@/lib/whatsapp-number-missing'

const CONTACT = { id: 'c1', name: 'Synthetic Member', first_name: 'Synthetic', location_id: 'loc-1', wa_phone: '+353000000000', phone: null }
let db
let inserts
function makeDb() {
  return {
    from: (table) => {
      const chain = {}
      for (const m of ['select', 'eq', 'order', 'limit']) chain[m] = () => chain
      chain.insert = (row) => { inserts.push({ table, row }); return Promise.resolve({ data: null, error: null }) }
      chain.maybeSingle = () => Promise.resolve({ data: table === 'contacts' ? CONTACT : null, error: null })
      chain.then = (res, rej) => Promise.resolve({ data: null, error: null }).then(res, rej)
      return chain
    },
  }
}
const req = (url, body) => new Request(url, { method: 'POST', body: JSON.stringify(body) })
const NO_NUMBER = { success: false, error: 'No WhatsApp number is connected at this location.' }

beforeEach(() => {
  vi.clearAllMocks()
  inserts = []
  db = makeDb()
  sendTextMessage.mockRejectedValue(new WhatsAppNumberMissingError('loc-1'))
  sendRadarOutreach.mockRejectedValue(new WhatsAppNumberMissingError('loc-1'))
})

describe('churn radar — no WhatsApp number at the active location', () => {
  it('winback_sent → 409 with the resolver message (not the message-window copy), nothing logged', async () => {
    const res = await churnPOST(req('http://localhost/api/churn-radar/action', { contact_id: 'c1', action: 'winback_sent' }))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual(NO_NUMBER)
    expect(inserts).toEqual([])
  })

  it('winback_sent with any other failure keeps the 502 + window copy', async () => {
    sendTextMessage.mockRejectedValue(new Error('(#131047) Re-engagement message'))
    const res = await churnPOST(req('http://localhost/api/churn-radar/action', { contact_id: 'c1', action: 'winback_sent' }))
    expect(res.status).toBe(502)
    expect((await res.json()).error).toMatch(/no open message window/)
  })

  it('outreach_sent → 409, nothing logged', async () => {
    const res = await churnPOST(req('http://localhost/api/churn-radar/action', { contact_id: 'c1', action: 'outreach_sent', template_name: 'checkin' }))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual(NO_NUMBER)
    expect(inserts).toEqual([])
  })
})

describe('lead radar — no WhatsApp number at the active location', () => {
  it('outreach_sent → 409, nothing logged', async () => {
    const res = await leadPOST(req('http://localhost/api/lead-radar/action', { contact_id: 'c1', action: 'outreach_sent', template_name: 'checkin' }))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual(NO_NUMBER)
    expect(inserts).toEqual([])
  })
})
