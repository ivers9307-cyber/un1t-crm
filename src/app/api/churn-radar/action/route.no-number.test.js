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
let locationRead
function makeDb() {
  return {
    from: (table) => {
      const chain = {}
      for (const m of ['select', 'eq', 'order', 'limit']) chain[m] = () => chain
      chain.insert = (row) => { inserts.push({ table, row }); return Promise.resolve({ data: null, error: null }) }
      chain.maybeSingle = () => {
        if (table === 'locations') return Promise.resolve(locationRead)
        return Promise.resolve({ data: table === 'contacts' ? CONTACT : null, error: null })
      }
      chain.then = (res, rej) => Promise.resolve({ data: null, error: null }).then(res, rej)
      return chain
    },
  }
}
const req = (url, body) => new Request(url, { method: 'POST', body: JSON.stringify(body) })
const NO_NUMBER = { success: false, error: 'No WhatsApp number is connected at this location.' }
// WAORGNUMBER.4 (R8) — the churn radar names its studio.
const NOT_SWITCHED_ON = { success: false, error: 'No WhatsApp number is switched on at UN1T Hatch Street.' }

beforeEach(() => {
  vi.clearAllMocks()
  inserts = []
  locationRead = { data: { name: 'UN1T Hatch Street' }, error: null }
  db = makeDb()
  sendTextMessage.mockRejectedValue(new WhatsAppNumberMissingError('loc-1'))
  sendRadarOutreach.mockRejectedValue(new WhatsAppNumberMissingError('loc-1'))
})

describe('churn radar — no WhatsApp number at the active location', () => {
  it('winback_sent → 409, radar refusal names the studio (not the message-window copy), nothing logged', async () => {
    const res = await churnPOST(req('http://localhost/api/churn-radar/action', { contact_id: 'c1', action: 'winback_sent' }))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual(NOT_SWITCHED_ON)
    expect(inserts).toEqual([])
  })

  it('winback_sent with any other failure keeps the 502 + window copy', async () => {
    sendTextMessage.mockRejectedValue(new Error('(#131047) Re-engagement message'))
    const res = await churnPOST(req('http://localhost/api/churn-radar/action', { contact_id: 'c1', action: 'winback_sent' }))
    expect(res.status).toBe(502)
    expect((await res.json()).error).toMatch(/no open message window/)
  })

  it('outreach_sent → 409, radar refusal names the studio, nothing logged', async () => {
    const res = await churnPOST(req('http://localhost/api/churn-radar/action', { contact_id: 'c1', action: 'outreach_sent', template_name: 'checkin' }))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual(NOT_SWITCHED_ON)
    expect(inserts).toEqual([])
  })

  it('a failed studio-name read still refuses (409), without the name', async () => {
    locationRead = { data: null, error: { message: 'boom' } }
    const res = await churnPOST(req('http://localhost/api/churn-radar/action', { contact_id: 'c1', action: 'winback_sent' }))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('No WhatsApp number is switched on at this studio.')
  })

  it('any other outreach failure keeps its 502', async () => {
    sendRadarOutreach.mockRejectedValue(new Error('Template not found'))
    const res = await churnPOST(req('http://localhost/api/churn-radar/action', { contact_id: 'c1', action: 'outreach_sent', template_name: 'checkin' }))
    expect(res.status).toBe(502)
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
