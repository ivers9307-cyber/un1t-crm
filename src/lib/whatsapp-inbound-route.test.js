// WAORGNUMBER.5 (spec R4) — routeInboundThread: which studio an inbound
// WhatsApp message lands at when the number is shared across an organisation.
// Fictional ids only: the repo is public.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('./supabase', () => ({ createServerClient: vi.fn() }))

import { routeInboundThread, RECENT_OUTBOUND_MS } from './whatsapp-inbound-route.js'
import { logWarn } from './log'
import { fakeWhatsAppDb, link } from './whatsapp-numbers-fake-db.test-helpers.js'

const ORG = 'd0000000-0000-4000-8000-000000000001'
const ORG2 = 'd0000000-0000-4000-8000-000000000002'
const STILL = 'loc-still'
const HATCH = 'loc-hatch'
const OTHER = 'loc-other'
const NUM = 'wn-1'
const PHONE = '353870000001'
const NOW = Date.parse('2026-10-18T12:00:00Z')
const ago = (ms) => new Date(NOW - ms).toISOString()
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

const LOCATIONS = [
  { id: STILL, organization_id: ORG },
  { id: HATCH, organization_id: ORG },
  { id: OTHER, organization_id: ORG },
  { id: 'loc-foreign', organization_id: ORG2 },
]
const NUMBERS = [
  { id: NUM, location_id: STILL, organization_id: ORG, is_active: true },
  { id: 'wn-other', location_id: OTHER, organization_id: ORG, is_active: true },
]
// Before go-live: the organisation number is switched on at Stillorgan only.
const PRE_GO_LIVE = [link(STILL, NUM, { is_default: true }), link(OTHER, 'wn-other', { is_default: true })]
// After go-live: Hatch switches it on too.
const GO_LIVE = [...PRE_GO_LIVE, link(HATCH, NUM, { is_default: true })]

const thread = (id, locationId, extra = {}) => ({
  id, location_id: locationId, contact_id: null, ctwa_clid: null, studio_resolution: null,
  wa_phone: PHONE, wa_bsuid: null, whatsapp_number_id: null, ...extra,
})
const outbound = (conversationId, sentAt, extra = {}) => ({
  conversation_id: conversationId, direction: 'outbound', sent_at: sentAt, wa_message_id: `wamid.${conversationId}.${sentAt}`, ...extra,
})

function makeDb({ links = GO_LIVE, conversations = [], messages = [], adEntities = [], faults = {} } = {}) {
  return fakeWhatsAppDb({
    locations: LOCATIONS,
    numbers: NUMBERS,
    links,
    conversations,
    whatsapp_messages: messages,
    ad_entities: adEntities,
    faults,
  })
}

const base = {
  numberId: NUM,
  numberHomeLocationId: STILL,
  waPhone: PHONE,
  bsuid: null,
  contact: null,
  contextMessageId: null,
  referral: null,
  now: NOW,
}

beforeEach(() => { vi.clearAllMocks() })

describe('routeInboundThread — the steps, in order (R4)', () => {
  it('RECENT_OUTBOUND_MS is seven days', () => {
    expect(RECENT_OUTBOUND_MS).toBe(7 * 24 * 60 * 60 * 1000)
  })

  it('quoted: a reply to a message in a thread at a candidate studio lands in that thread', async () => {
    const hatch = thread('conv-hatch', HATCH)
    const db = makeDb({
      conversations: [thread('conv-still', STILL), hatch],
      messages: [
        { conversation_id: 'conv-hatch', location_id: HATCH, direction: 'outbound', sent_at: ago(10 * DAY), wa_message_id: 'wamid.quoted' },
        outbound('conv-still', ago(HOUR), { location_id: STILL }),
      ],
    })
    const r = await routeInboundThread(db, { ...base, contact: { id: 'c1', location_id: STILL }, contextMessageId: 'wamid.quoted' })
    expect(r).toMatchObject({ locationId: HATCH, by: 'quoted', switchedOn: true })
    expect(r.conversation).toMatchObject({ id: 'conv-hatch', location_id: HATCH })
  })

  it('quoted: a quoted message at a studio that is not a candidate is ignored', async () => {
    const db = makeDb({
      links: PRE_GO_LIVE,
      conversations: [thread('conv-hatch', HATCH)],
      messages: [{ conversation_id: 'conv-hatch', location_id: HATCH, direction: 'outbound', sent_at: ago(HOUR), wa_message_id: 'wamid.quoted' }],
    })
    const r = await routeInboundThread(db, { ...base, contact: { id: 'c1', location_id: STILL }, contextMessageId: 'wamid.quoted' })
    expect(r).toMatchObject({ locationId: STILL, by: 'home' })
  })

  it('ad: a click-to-WhatsApp ad that belongs to a candidate studio wins, even for a known member of another studio', async () => {
    const db = makeDb({
      conversations: [thread('conv-still', STILL)],
      messages: [outbound('conv-still', ago(HOUR))],
      adEntities: [{ level: 'ad', external_id: 'ad-9', location_id: HATCH }],
    })
    const r = await routeInboundThread(db, {
      ...base, contact: { id: 'c1', location_id: STILL }, referral: { source_type: 'ad', source_id: 'ad-9', ctwa_clid: 'clid-1' },
    })
    expect(r).toMatchObject({ locationId: HATCH, by: 'ad', conversation: null, switchedOn: true })
  })

  it('recent: a Hatch member replying to a Stillorgan campaign within 7 days lands at Stillorgan', async () => {
    const db = makeDb({
      conversations: [thread('conv-still', STILL, { contact_id: 'c1' }), thread('conv-hatch', HATCH, { contact_id: 'c1' })],
      messages: [outbound('conv-still', ago(DAY)), outbound('conv-hatch', ago(9 * DAY))],
    })
    const r = await routeInboundThread(db, { ...base, contact: { id: 'c1', location_id: HATCH } })
    expect(r).toMatchObject({ locationId: STILL, by: 'recent', switchedOn: true })
    expect(r.conversation).toMatchObject({ id: 'conv-still' })
  })

  it('outbound older than 7 days falls through to home', async () => {
    const db = makeDb({
      conversations: [thread('conv-still', STILL, { contact_id: 'c1' })],
      messages: [outbound('conv-still', ago(8 * DAY))],
    })
    const r = await routeInboundThread(db, { ...base, contact: { id: 'c1', location_id: HATCH } })
    expect(r).toMatchObject({ locationId: HATCH, by: 'home', conversation: null, switchedOn: true })
  })

  it('a history row only considers outbound in the week before it', async () => {
    // A coexistence history row from 18 days ago: Stillorgan spoke 19 days ago
    // (in the week before it); Hatch spoke yesterday (after it, within a week
    // of today). The row files with Stillorgan, not whoever spoke most recently.
    const db = makeDb({
      conversations: [thread('conv-still', STILL, { contact_id: 'c1' }), thread('conv-hatch', HATCH, { contact_id: 'c1' })],
      messages: [outbound('conv-still', ago(19 * DAY)), outbound('conv-hatch', ago(DAY))],
    })
    const r = await routeInboundThread(db, { ...base, contact: { id: 'c1', location_id: HATCH }, now: NOW - 18 * DAY })
    expect(r).toMatchObject({ locationId: STILL, by: 'recent' })
    expect(r.conversation).toMatchObject({ id: 'conv-still' })
  })

  it('a failed outbound does not count: the earlier delivered one wins', async () => {
    const db = makeDb({
      conversations: [thread('conv-still', STILL), thread('conv-hatch', HATCH)],
      messages: [outbound('conv-hatch', ago(HOUR), { status: 'failed' }), outbound('conv-still', ago(3 * DAY), { status: 'delivered' })],
    })
    expect(await routeInboundThread(db, base)).toMatchObject({ locationId: STILL, by: 'recent' })
  })

  it('an inbound message is not "outbound": a recent customer message does not pull the reply to that studio', async () => {
    const db = makeDb({
      conversations: [thread('conv-still', STILL, { contact_id: 'c1' })],
      messages: [{ conversation_id: 'conv-still', direction: 'inbound', sent_at: ago(HOUR), wa_message_id: 'wamid.in' }],
    })
    const r = await routeInboundThread(db, { ...base, contact: { id: 'c1', location_id: HATCH } })
    expect(r).toMatchObject({ locationId: HATCH, by: 'home' })
  })

  it('home: the member’s home studio when the number is switched on there', async () => {
    const db = makeDb({ conversations: [thread('conv-hatch', HATCH, { contact_id: 'c1' })] })
    const r = await routeInboundThread(db, { ...base, contact: { id: 'c1', location_id: HATCH } })
    expect(r).toMatchObject({ locationId: HATCH, by: 'home' })
    expect(r.conversation).toMatchObject({ id: 'conv-hatch' })
  })

  it('WAORGNUMBER.6: a member whose home studio has nothing switched on lands at the number’s home, never at the number-less studio', async () => {
    const db = makeDb({ links: PRE_GO_LIVE })
    const r = await routeInboundThread(db, { ...base, contact: { id: 'c1', location_id: HATCH } })
    expect(r).toMatchObject({ locationId: STILL, by: 'number_home', conversation: null, switchedOn: true })
  })

  it('home not switched on → number home', async () => {
    // loc-other has its own number switched on, but not this one, so it is not a candidate.
    const db = makeDb({ conversations: [thread('conv-still', STILL)] })
    const r = await routeInboundThread(db, { ...base, contact: { id: 'c1', location_id: OTHER } })
    expect(r).toMatchObject({ locationId: STILL, by: 'number_home', switchedOn: true })
    expect(r.conversation).toMatchObject({ id: 'conv-still' })
  })

  it('unknown sender → number home', async () => {
    const r = await routeInboundThread(makeDb(), base)
    expect(r).toMatchObject({ locationId: STILL, by: 'number_home', conversation: null, switchedOn: true })
  })

  it('two recent threads → the later outbound (Review Focus 4)', async () => {
    const conversations = [thread('conv-still', STILL), thread('conv-hatch', HATCH)]
    const later = await routeInboundThread(makeDb({
      conversations, messages: [outbound('conv-hatch', ago(HOUR)), outbound('conv-still', ago(2 * HOUR))],
    }), base)
    expect(later).toMatchObject({ locationId: HATCH, by: 'recent' })
    const flipped = await routeInboundThread(makeDb({
      conversations, messages: [outbound('conv-hatch', ago(2 * HOUR)), outbound('conv-still', ago(HOUR))],
    }), base)
    expect(flipped).toMatchObject({ locationId: STILL, by: 'recent' })
  })

  it('a tie on sent_at goes to the higher thread id, whatever order the rows come in', async () => {
    const at = ago(HOUR)
    const conversations = [thread('conv-a', STILL), thread('conv-b', HATCH)]
    for (const messages of [
      [outbound('conv-a', at), outbound('conv-b', at)],
      [outbound('conv-b', at), outbound('conv-a', at)],
    ]) {
      const r = await routeInboundThread(makeDb({ conversations, messages }), base)
      expect(r).toMatchObject({ locationId: HATCH, by: 'recent', conversation: expect.objectContaining({ id: 'conv-b' }) })
    }
  })

  it('bsuid-only sender: their threads are found by wa_bsuid', async () => {
    const db = makeDb({
      conversations: [thread('conv-hatch', HATCH, { wa_phone: null, wa_bsuid: 'IE.bsuid-1' })],
      messages: [outbound('conv-hatch', ago(HOUR))],
    })
    const r = await routeInboundThread(db, { ...base, waPhone: null, bsuid: 'IE.bsuid-1' })
    expect(r).toMatchObject({ locationId: HATCH, by: 'recent' })
    expect(r.conversation).toMatchObject({ id: 'conv-hatch' })
  })

  it('a thread at a studio outside the candidates never counts as recent', async () => {
    const db = makeDb({
      links: PRE_GO_LIVE,
      conversations: [thread('conv-other', OTHER)],
      messages: [outbound('conv-other', ago(HOUR))],
    })
    const r = await routeInboundThread(db, base)
    expect(r).toMatchObject({ locationId: STILL, by: 'number_home' })
  })
})

describe('routeInboundThread — a thread staff moved to a number-less studio (WAORGNUMBER.6)', () => {
  it('is no longer followed: the message lands at the number’s home', async () => {
    const db = makeDb({ links: PRE_GO_LIVE, conversations: [thread('conv-hatch', HATCH, { whatsapp_number_id: NUM })] })
    const r = await routeInboundThread(db, base)
    expect(r).toMatchObject({ locationId: STILL, by: 'number_home', conversation: null, switchedOn: true })
  })
})

describe('routeInboundThread — never throws', () => {
  it('read error falls through: a failed messages read skips quoted and recent, logged', async () => {
    // Without the fault this would be 'quoted' (Stillorgan): the fault is what turns it to home.
    const db = makeDb({
      conversations: [thread('conv-still', STILL)],
      messages: [{ ...outbound('conv-still', ago(HOUR)), location_id: STILL, wa_message_id: 'wamid.x' }],
      faults: { whatsapp_messages: { message: 'messages down' } },
    })
    expect(await routeInboundThread(makeDb({
      conversations: [thread('conv-still', STILL)],
      messages: [{ ...outbound('conv-still', ago(HOUR)), location_id: STILL, wa_message_id: 'wamid.x' }],
    }), { ...base, contact: { id: 'c1', location_id: HATCH }, contextMessageId: 'wamid.x' })).toMatchObject({ locationId: STILL, by: 'quoted' })
    const r = await routeInboundThread(db, { ...base, contact: { id: 'c1', location_id: HATCH }, contextMessageId: 'wamid.x' })
    expect(r).toMatchObject({ locationId: HATCH, by: 'home' })
    expect(logWarn).toHaveBeenCalled()
  })

  it('a failed link read leaves the number’s home as the only candidate (and treats it as switched on)', async () => {
    const db = makeDb({ faults: { location_whatsapp_numbers: { message: 'links down' } } })
    const r = await routeInboundThread(db, { ...base, contact: { id: 'c1', location_id: HATCH } })
    expect(r).toMatchObject({ locationId: STILL, by: 'number_home', switchedOn: true })
    expect(logWarn).toHaveBeenCalled()
  })

  it('a failed conversation read gives no conversation, logged', async () => {
    const db = makeDb({ faults: { whatsapp_conversations: { message: 'conversations down' } } })
    const r = await routeInboundThread(db, { ...base, contact: { id: 'c1', location_id: HATCH } })
    expect(r).toMatchObject({ locationId: HATCH, by: 'home', conversation: null })
    expect(logWarn).toHaveBeenCalled()
  })

  it('a client that throws synchronously still answers the number’s home', async () => {
    const db = { from: () => { throw new Error('client exploded') } }
    const r = await routeInboundThread(db, { ...base, contact: { id: 'c1', location_id: HATCH } })
    expect(r).toMatchObject({ locationId: STILL, by: 'number_home', conversation: null })
  })
})

// ORGCONTACTS.3 — step 4 reads the person's relationship rows (contact_studios):
// the candidate studio with an active relationship, by last activity; the
// home studio is the explicit fallback (spec §3.4).
describe('routeInboundThread — step 4: the studio with an active relationship (ORGCONTACTS.3)', () => {
  const row = (locationId, status, lastSeenAt) => ({ location_id: locationId, status, last_seen_at: lastSeenAt })
  const withRows = (contactStudios, home = STILL) => ({ ...base, contact: { id: 'c1', location_id: home }, contactStudios })

  it('an active row at one candidate wins over the home studio', async () => {
    const r = await routeInboundThread(makeDb(), withRows([row(HATCH, 'active', ago(DAY))], STILL))
    expect(r).toMatchObject({ locationId: HATCH, by: 'relationship', conversation: null, switchedOn: true })
  })

  it('two active rows: later last_seen_at wins', async () => {
    const later = await routeInboundThread(makeDb(), withRows([row(STILL, 'active', ago(3 * DAY)), row(HATCH, 'active', ago(DAY))], STILL))
    expect(later).toMatchObject({ locationId: HATCH, by: 'relationship' })
    const flipped = await routeInboundThread(makeDb(), withRows([row(STILL, 'active', ago(DAY)), row(HATCH, 'active', ago(3 * DAY))], HATCH))
    expect(flipped).toMatchObject({ locationId: STILL, by: 'relationship' })
  })

  it('equal last_seen_at: primary studio wins when it is one of them, else lower location_id (Review Focus 3)', async () => {
    const at = ago(DAY)
    const primaryWins = await routeInboundThread(makeDb(), withRows([row(HATCH, 'active', at), row(STILL, 'active', at)], STILL))
    expect(primaryWins).toMatchObject({ locationId: STILL, by: 'relationship' })
    const primaryElsewhere = await routeInboundThread(makeDb(), withRows([row(STILL, 'active', at), row(HATCH, 'active', at)], OTHER))
    expect(primaryElsewhere).toMatchObject({ locationId: HATCH, by: 'relationship' })
  })

  it('ended rows are ignored; none active → home if candidate, else number home', async () => {
    const home = await routeInboundThread(makeDb(), withRows([row(HATCH, 'ended', ago(DAY))], STILL))
    expect(home).toMatchObject({ locationId: STILL, by: 'home' })
    const numberHome = await routeInboundThread(makeDb(), withRows([row(HATCH, 'ended', ago(DAY))], OTHER))
    expect(numberHome).toMatchObject({ locationId: STILL, by: 'number_home' })
  })

  it("null contactStudios → today's home rule", async () => {
    const db = makeDb({ conversations: [thread('conv-hatch', HATCH, { contact_id: 'c1' })] })
    const r = await routeInboundThread(db, withRows(null, HATCH))
    expect(r).toMatchObject({ locationId: HATCH, by: 'home' })
    expect(r.conversation).toMatchObject({ id: 'conv-hatch' })
  })

  it('a row at a non-candidate studio is ignored', async () => {
    const r = await routeInboundThread(makeDb(), withRows([row(OTHER, 'active', ago(DAY))], STILL))
    expect(r).toMatchObject({ locationId: STILL, by: 'home' })
  })

  it('a recent outbound (step 3) still wins over the relationship row', async () => {
    const db = makeDb({
      conversations: [thread('conv-still', STILL, { contact_id: 'c1' })],
      messages: [outbound('conv-still', ago(HOUR))],
    })
    const r = await routeInboundThread(db, withRows([row(HATCH, 'active', ago(DAY))], HATCH))
    expect(r).toMatchObject({ locationId: STILL, by: 'recent' })
  })
})
