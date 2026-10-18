// UN1TRADAR.3 — the radar's acting routes at a un1t.online studio: triage logs
// only (no contacts write), the Glofox-only payment reminder and refresh are
// refused with exact copy, and an outreach refusal is logged once with no
// action row. A Glofox studio is unchanged.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(async () => USER) }))
vi.mock('@/lib/permissions', () => ({ hasPermission: vi.fn(() => true) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/radar-cache', () => ({ invalidateRadar: vi.fn(), radarCache: vi.fn() }))
vi.mock('@/lib/contact-crossovers', () => ({ isCrossoverAt: vi.fn(async () => false), crossoverIdsAt: vi.fn(async () => new Set()) }))
vi.mock('@/lib/membership/reads/index', () => ({ radarReadsFor: vi.fn() }))
vi.mock('@/lib/radar-availability', () => ({ syncDataAsOf: vi.fn(async () => '2026-10-18T11:45:00Z') }))
vi.mock('@/lib/location-time', async (importOriginal) => ({ ...(await importOriginal()), getLocationZone: vi.fn(async () => 'Europe/Dublin') }))
vi.mock('@/lib/glofox', () => ({ glofoxCredentialsForLocation: vi.fn(), glofoxFetch: vi.fn() }))
vi.mock('@/lib/whatsapp', () => ({ sendTextMessage: vi.fn() }))
vi.mock('@/lib/radar-outreach', () => ({ sendRadarOutreach: vi.fn() }))
vi.mock('@/lib/sequences', () => ({ enrolContacts: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))

import { radarReadsFor } from '@/lib/membership/reads/index'
import { glofoxCredentialsForLocation } from '@/lib/glofox'
import { sendRadarOutreach } from '@/lib/radar-outreach'
import { logInfo } from '@/lib/log'
import { WhatsAppNumberMissingError } from '@/lib/whatsapp-number-missing'
import { POST as actionPOST } from './action/route.js'
import { POST as refreshPOST } from './refresh-member/route.js'
import { POST as quarantinePOST } from './quarantine/route.js'
import { POST as cleanupPOST } from '../lead-radar/cleanup/route.js'
import { POST as leadActionPOST } from '../lead-radar/action/route.js'

const L = 'loc-hatch'
const USER = { id: 'u1', profileRole: 'master', activeLocation: { id: L }, rolesByLocation: { [L]: 'owner' } }
const CONTACT = { id: 'c1', name: 'Member', first_name: 'Member', location_id: L, wa_phone: '+353000000000', phone: null, glofox_member_id: null }
let db
let writes

function makeDb() {
  return {
    from(table) {
      const s = { table, filters: [] }
      const c = {}
      for (const m of ['select', 'order', 'limit']) c[m] = () => c
      c.eq = (k, v) => { s.filters.push(['eq', k, v]); return c }
      c.in = (k, v) => { s.filters.push(['in', k, v]); return c }
      c.update = (patch) => { s.update = patch; return c }
      c.insert = (rows) => { writes.push({ table, insert: rows }); return Promise.resolve({ data: null, error: null }) }
      c.maybeSingle = () => Promise.resolve({ data: table === 'contacts' ? CONTACT : (table === 'locations' ? { name: 'Studio' } : null), error: null })
      c.then = (res, rej) => {
        if (s.update) { writes.push({ table, update: s.update }); return Promise.resolve({ data: null, error: null }).then(res, rej) }
        if (table === 'contacts') return Promise.resolve({ data: [{ id: 'c1' }], error: null }).then(res, rej)
        return Promise.resolve({ data: [], error: null }).then(res, rej)
      }
      return c
    },
  }
}
const req = (path, body) => new Request(`http://localhost${path}`, { method: 'POST', body: JSON.stringify(body) })
const asSource = (source) => radarReadsFor.mockResolvedValue({ source, reads: {}, providesMemberships: source === 'glofox', pinArrears: source === 'un1t_online' })

beforeEach(() => { vi.clearAllMocks(); writes = []; db = makeDb() })

describe('acting routes at a un1t.online studio', () => {
  it('quarantine stale at a un1t studio performs no contacts update (action row only)', async () => {
    asSource('un1t_online')
    const res = await quarantinePOST(req('/api/churn-radar/quarantine', { decision: 'stale', contact_ids: ['c1'] }))
    expect(res.status).toBe(200)
    expect(writes.some((w) => w.table === 'contacts')).toBe(false)
    expect(writes.find((w) => w.insert).insert[0]).toMatchObject({ contact_id: 'c1', action: 'quarantine_stale' })
  })

  it('cleanup archive at a un1t studio logs only', async () => {
    asSource('un1t_online')
    const res = await cleanupPOST(req('/api/lead-radar/cleanup', { decision: 'archive', contact_ids: ['c1'] }))
    expect(res.status).toBe(200)
    expect(writes.some((w) => w.table === 'contacts')).toBe(false)
    expect(writes.find((w) => w.insert).insert[0]).toMatchObject({ contact_id: 'c1', action: 'cleanup_archive' })
  })

  it('Glofox studio: stale still writes dormant (unchanged)', async () => {
    asSource('glofox')
    await quarantinePOST(req('/api/churn-radar/quarantine', { decision: 'stale', contact_ids: ['c1'] }))
    expect(writes.find((w) => w.update)).toEqual({ table: 'contacts', update: { pipeline_stage_slug: 'dormant' } })
  })

  it('payment_reminder 409 with the exact copy at a un1t studio', async () => {
    asSource('un1t_online')
    const res = await actionPOST(req('/api/churn-radar/action', { contact_id: 'c1', action: 'payment_reminder' }))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ success: false, error: 'Payment reminders are not available for un1t.online studios yet.' })
    expect(writes).toEqual([])
  })

  it('refresh-member 409 with the last sync time on the studio clock', async () => {
    asSource('un1t_online')
    const res = await refreshPOST(req('/api/churn-radar/refresh-member', { contact_id: '00000000-0000-4000-8000-000000000001' }))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ success: false, error: 'un1t.online data refreshes every 15 minutes, last at 12:45' })
    expect(glofoxCredentialsForLocation).not.toHaveBeenCalled()
  })

  it('outreach at a number-less studio: 409, one log, no action row, no further send', async () => {
    asSource('un1t_online')
    sendRadarOutreach.mockRejectedValue(new WhatsAppNumberMissingError(L))
    const res = await actionPOST(req('/api/churn-radar/action', { contact_id: 'c1', action: 'outreach_sent', template_name: 'checkin' }))
    expect(res.status).toBe(409)
    expect(writes).toEqual([])
    expect(logInfo).toHaveBeenCalledWith('churn-radar', 'outreach refused: studio has no WhatsApp number', { locationId: L })
    expect(logInfo.mock.calls.filter(([, m]) => m === 'outreach refused: studio has no WhatsApp number')).toHaveLength(1)
    const lead = await leadActionPOST(req('/api/lead-radar/action', { contact_id: 'c1', action: 'outreach_sent', template_name: 'checkin' }))
    expect(lead.status).toBe(409)
    expect(logInfo).toHaveBeenCalledWith('lead-radar', 'outreach refused: studio has no WhatsApp number', { locationId: L })
  })
})

describe('an unreadable membership source (radarReadsFor throws)', () => {
  const unreadable = () => radarReadsFor.mockRejectedValue(Object.assign(new Error('source unreadable'), { code: 'MEMBERSHIP_SOURCE_UNREADABLE' }))
  const SOURCE_503 = { success: false, error: "Could not read this studio's membership source. Try again shortly." }

  it('quarantine stale and cleanup archive answer 503 with a JSON body and write nothing', async () => {
    unreadable()
    for (const [post, path, decision] of [[quarantinePOST, '/api/churn-radar/quarantine', 'stale'], [cleanupPOST, '/api/lead-radar/cleanup', 'archive']]) {
      const res = await post(req(path, { decision, contact_ids: ['c1'] }))
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual(SOURCE_503)
    }
    expect(writes).toEqual([])
  })

  it('keep decisions never read the source, so they still log', async () => {
    unreadable()
    expect((await quarantinePOST(req('/api/churn-radar/quarantine', { decision: 'keep', contact_ids: ['c1'] }))).status).toBe(200)
    expect((await cleanupPOST(req('/api/lead-radar/cleanup', { decision: 'keep', contact_ids: ['c1'] }))).status).toBe(200)
    expect(radarReadsFor).not.toHaveBeenCalled()
  })

  it('payment_reminder and refresh-member answer 503 with a JSON body', async () => {
    unreadable()
    const pay = await actionPOST(req('/api/churn-radar/action', { contact_id: 'c1', action: 'payment_reminder' }))
    expect(pay.status).toBe(503)
    expect(await pay.json()).toEqual(SOURCE_503)
    const ref = await refreshPOST(req('/api/churn-radar/refresh-member', { contact_id: '00000000-0000-4000-8000-000000000001' }))
    expect(ref.status).toBe(503)
    expect(await ref.json()).toEqual(SOURCE_503)
    expect(writes).toEqual([])
    expect(glofoxCredentialsForLocation).not.toHaveBeenCalled()
  })
})
