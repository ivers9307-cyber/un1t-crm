// UN1TWRITE.19 — the WhatsApp booking Flow's terms and waiver OptIn: shown
// and required only at a un1t.online studio with the funnel on, recorded on
// the queue row with time, source 'whatsapp_flow' and version.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/booking-slots.js', () => ({ computeAvailableDays: vi.fn(), computeAvailableSlots: vi.fn() }))
vi.mock('@/lib/public-classes.js', () => ({ listPublicClasses: vi.fn(async () => []) }))
vi.mock('@/lib/marketing-consent.js', () => ({ applyFormMarketingConsent: vi.fn(async () => ({})) }))
vi.mock('@/lib/bookings-write.js', () => ({ createEventBooking: vi.fn() }))
vi.mock('@/lib/qstash.js', () => ({ publishQueuePush: vi.fn(async () => ({ ok: true })), CLASS_BOOKINGS_WORKER_PATH: '/x' }))
vi.mock('@/lib/app-url', () => ({ getAppUrl: () => 'https://crm.example.com' }))
let settings
vi.mock('@/lib/un1t-online-settings', async (importOriginal) => ({ ...(await importOriginal()), readUn1tWriteSettings: vi.fn(async () => settings) }))
vi.mock('@/lib/un1t-online-legal', async (importOriginal) => ({ ...(await importOriginal()), readUn1tLegalDocs: vi.fn(async () => ({ version: 'terms:a|waiver:b' })) }))

import { FLOW_JSON, detailsScreen, SCREEN } from './screens.js'
import { handleDataExchange, parseFlowCompletion } from './handler.js'
import { handleFlowCompletion } from './completion.js'
import { readUn1tWriteSettings } from '@/lib/un1t-online-settings'

const un1t = (funnel) => ({ membershipSource: 'un1t_online', studioName: 'Hatch Street', settings: { writesEnabled: funnel, funnelEnabled: funnel } })
const glofox = { membershipSource: 'glofox', studioName: 'Stillorgan', settings: { writesEnabled: false, funnelEnabled: false } }

// The studio's own page (kind='studio', primary L1): its slug is the terms
// page's path and its chrome.un1t_terms the operator's wording.
let terms
let studioPageError
const inserts = []
const db = {
  from(table) {
    const b = {
      select: () => b, eq: () => b, order: () => b,
      maybeSingle: async () => {
        if (table === 'landing_pages') {
          if (studioPageError) return { data: null, error: studioPageError }
          return { data: { id: 'p-h', slug: 'hatch-street', kind: 'studio', scope: 'one', primary_location_id: 'L1', offer_type: 'class_funnel', publish_state: 'live', blocks: [{ type: 'class_funnel' }], chrome: { un1t_terms: terms } }, error: null }
        }
        return { data: { id: 'Q1' }, error: null }
      },
      then: (res, rej) => Promise.resolve({ data: [], error: null }).then(res, rej),
      insert: (row) => { inserts.push({ table, row }); return b },
    }
    return b
  },
}
const contact = { id: 'ct1', name: 'Ann', email: 'ann@x.ie', phone: '+353871234567' }
const exchange = (screen, data) => handleDataExchange(db, { decryptedBody: { action: 'data_exchange', screen, data }, contact, locationId: 'L1', config: {} })
const completion = (payload) => ({ type: 'nfm_reply', nfm_reply: { response_json: JSON.stringify(payload) } })

beforeEach(() => { vi.clearAllMocks(); inserts.length = 0; terms = {}; studioPageError = null; settings = un1t(true) })

describe('FLOW_JSON', () => {
  const byId = Object.fromEntries(FLOW_JSON.screens.map((s) => [s.id, s]))
  const form = byId.DETAILS.layout.children[0]

  it('DETAILS has the bound OptIn and an error caption', () => {
    const optIn = form.children.find((c) => c.type === 'OptIn' && c.name === 'terms_accepted')
    expect(optIn).toEqual({
      type: 'OptIn', name: 'terms_accepted', label: '${data.terms_label}',
      visible: '${data.terms_required}', required: '${data.terms_required}',
      'on-click-action': { name: 'open_url', url: '${data.terms_url}' },
    })
    expect(form.children.some((c) => c.type === 'TextCaption' && c.text === '${data.terms_error}')).toBe(true)
    expect(form['init-values'].terms_accepted).toBe('${data.terms_accepted}')
    for (const k of ['terms_required', 'terms_label', 'terms_url', 'terms_accepted', 'terms_error']) expect(byId.DETAILS.data[k], k).toBeDefined()
  })

  it('the SLOT footer marks the new Flow so the handler can send every declared key', () => {
    const slotFooter = byId.SLOT.layout.children[0].children.find((c) => c.type === 'Footer')
    expect(slotFooter['on-click-action'].payload.terms_flow).toBe('1')
  })

  it('every DETAILS to CONFIRM to complete payload forwards terms_accepted', () => {
    expect(form.children.find((c) => c.type === 'Footer')['on-click-action'].payload.terms_accepted).toBe('${form.terms_accepted}')
    expect(byId.CONFIRM.data.selection.properties.terms_accepted).toEqual({ type: 'boolean' })
    const done = byId.CONFIRM.layout.children[0].children.find((c) => c.type === 'Footer')['on-click-action']
    expect(done.name).toBe('complete')
    expect(done.payload.terms_accepted).toBe('${data.selection.terms_accepted}')
  })
})

describe('detailsScreen', () => {
  it('defaults send no terms keys at all (the Flow published before this declares none)', () => {
    const d = detailsScreen({ name: 'Ann' }, { path: 'class', slot: 's' }).data
    expect(Object.keys(d).sort()).toEqual(['email', 'marketing_opt_in', 'name', 'path', 'slot'])
  })
})

describe('handler', () => {
  it('at a un1t.online funnel studio DETAILS asks for the tick, with the label as text and the terms page url', async () => {
    const res = await exchange(SCREEN.SLOT, { path: 'class', slot: 'un1t:e|2099-01-01T08:00:00Z|BASE' })
    expect(res.screen).toBe(SCREEN.DETAILS)
    expect(res.data).toMatchObject({
      terms_required: true,
      terms_label: "I accept Hatch Street's terms and conditions and liability waiver",
      terms_url: 'https://crm.example.com/legal/un1t/hatch-street/terms',
      terms_accepted: false, terms_error: '',
    })
  })

  it("the studio page's own terms wording is the label and the studio page's slug is the link", async () => {
    terms = { terms_label: 'I agree to the {terms} and {waiver} of {studio_name}', terms_link_label: 'T and Cs', waiver_link_label: 'waiver', terms_required_message: 'Tick it please.' }
    const res = await exchange(SCREEN.SLOT, { path: 'class', slot: 's' })
    expect(res.data).toMatchObject({ terms_required: true, terms_label: 'I agree to the T and Cs and waiver of Hatch Street', terms_url: 'https://crm.example.com/legal/un1t/hatch-street/terms' })
    const again = await exchange(SCREEN.DETAILS, { path: 'class', slot: 's', name: 'Ann', email: 'ann@x.ie', marketing_opt_in: true, terms_accepted: false })
    expect(again.data.terms_error).toBe('Tick it please.')
  })

  it('an unreadable studio page never asks (no link, no tick), never throws', async () => {
    studioPageError = { code: 'XX' }
    const res = await exchange(SCREEN.SLOT, { path: 'class', slot: 's' })
    expect(res.data).not.toHaveProperty('terms_required')
  })

  it('returns DETAILS with the error until ticked, then CONFIRM carrying the tick', async () => {
    const data = { path: 'class', slot: 's', name: 'Ann', email: 'ann@x.ie', marketing_opt_in: true, terms_accepted: false }
    const again = await exchange(SCREEN.DETAILS, data)
    expect(again.screen).toBe(SCREEN.DETAILS)
    expect(again.data.terms_error).toBe('Please tick to accept the terms and waiver.')
    expect(again.data).toMatchObject({ name: 'Ann', email: 'ann@x.ie', slot: 's', terms_required: true })
    const ok = await exchange(SCREEN.DETAILS, { ...data, terms_accepted: true })
    expect(ok.screen).toBe(SCREEN.CONFIRM)
    expect(ok.data.selection.terms_accepted).toBe(true)
  })

  it('at Stillorgan (or with the funnel off, or settings unreadable) it never asks', async () => {
    for (const s of [glofox, un1t(false)]) {
      settings = s
      const d = await exchange(SCREEN.SLOT, { path: 'class', slot: 's' })
      expect(d.data).not.toHaveProperty('terms_required')
      const c = await exchange(SCREEN.DETAILS, { path: 'class', slot: 's', name: 'A', email: 'a@x.ie', marketing_opt_in: true })
      expect(c.screen).toBe(SCREEN.CONFIRM)
      expect(c.data.selection).not.toHaveProperty('terms_accepted')
    }
    readUn1tWriteSettings.mockRejectedValueOnce(new Error('down'))
    expect((await exchange(SCREEN.SLOT, { path: 'class', slot: 's' })).data).not.toHaveProperty('terms_required')
  })

  it('the new Flow (terms_flow posted) gets every declared key at a studio that does not ask', async () => {
    settings = glofox
    const d = await exchange(SCREEN.SLOT, { path: 'class', slot: 's', terms_flow: '1' })
    expect(d.data).toMatchObject({ terms_required: false, terms_label: '', terms_url: '', terms_accepted: false, terms_error: '' })
  })

  it('the Flow published before this change (no terms_accepted posted) is never trapped on DETAILS', async () => {
    const c = await exchange(SCREEN.DETAILS, { path: 'class', slot: 's', name: 'A', email: 'a@x.ie', marketing_opt_in: true })
    expect(c.screen).toBe(SCREEN.CONFIRM)
    expect(c.data.selection).not.toHaveProperty('terms_accepted')
  })

  it('never asks when the terms link cannot be built, and cuts a long label', async () => {
    terms = { terms_label: 'x'.repeat(300) }
    const long = await exchange(SCREEN.SLOT, { path: 'class', slot: 's' })
    expect(long.data.terms_label.length).toBe(120)
    const saved = db.from
    db.from = () => { const b = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: null, error: null }) }; return b }
    try {
      expect((await exchange(SCREEN.SLOT, { path: 'class', slot: 's' })).data).not.toHaveProperty('terms_required')
    } finally { db.from = saved }
  })
})

describe('completion', () => {
  it('parseFlowCompletion returns terms_accepted as a boolean', () => {
    expect(parseFlowCompletion(completion({ path: 'class', slot: 's', terms_accepted: 'true' })).contactFields.terms_accepted).toBe(true)
    expect(parseFlowCompletion(completion({ path: 'class', slot: 's' })).contactFields.terms_accepted).toBe(false)
  })

  it('records time, source whatsapp_flow and version on the queue row', async () => {
    await handleFlowCompletion(db, { interactive: completion({ path: 'class', slot: 'un1t:e|2099-01-01T08:00:00Z|BASE', name: 'Ann', email: 'ann@x.ie', terms_accepted: true }), contact, locationId: 'L1' })
    const row = inserts.find((i) => i.table === 'class_booking_requests').row
    expect(row.terms_source).toBe('whatsapp_flow')
    expect(Number.isFinite(Date.parse(row.terms_accepted_at))).toBe(true)
    expect(row.terms_version).toBe('terms:a|waiver:b')
  })

  it('without a tick at a un1t studio the row is queued with no acceptance; Stillorgan is unchanged', async () => {
    await handleFlowCompletion(db, { interactive: completion({ path: 'class', slot: 'un1t:e|x|BASE', name: 'Ann', email: 'ann@x.ie' }), contact, locationId: 'L1' })
    expect(inserts[0].row).not.toHaveProperty('terms_source')
    inserts.length = 0
    settings = glofox
    await handleFlowCompletion(db, { interactive: completion({ path: 'class', slot: 'c1|x|HIIT', name: 'Ann', email: 'ann@x.ie', terms_accepted: true }), contact, locationId: 'L1' })
    expect(inserts[0].row).not.toHaveProperty('terms_source')
    expect(inserts[0].row.status).toBe('queued')
  })
})
