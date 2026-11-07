// PIPEBUILD.3c — the claim loaders behind offer boards: one read per entry type
// actually used, a recorded claim for the three signal-on-the-contact types.
import { describe, it, expect, vi } from 'vitest'
import {
  splitOfferBoards, loadOfferClaimsForLocation, loadOfferClaimsForContact,
  trialPurchaseOfferConfigs, offerPurchaseEntries, withoutOfferPurchases, placementDescriptors, offerPlacementSilence,
  un1tProductOfferClaim, loadUn1tOfferClaims,
} from './pipeline-offer-claims.js'
import { loadClaimsForLocation, pendingProgrammeClaims } from './pipeline-claims.js'

vi.mock('./log.js', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

const DAY = 86_400_000
const T0 = Date.parse('2026-11-01T10:00:00Z')
const iso = (ms) => new Date(ms).toISOString()
const LOC = 'a0000000-0000-0000-0000-000000000001'

function fakeDb(tables = {}, { errors = {} } = {}) {
  const writes = []
  const reads = []
  function chain(table) {
    const filters = []
    let op = 'select'
    let payload = null
    const c = {}
    c.select = () => c
    c.order = () => c
    c.range = () => c
    c.eq = (col, val) => { filters.push({ op: 'eq', col, val }); return c }
    c.in = (col, vals) => { filters.push({ op: 'in', col, vals }); return c }
    c.is = (col, val) => { filters.push({ op: 'is', col, val }); return c }
    c.upsert = (rows) => { op = 'upsert'; payload = rows; return c }
    c.then = (resolve) => {
      if (errors[table]) { reads.push(table); return resolve({ data: null, error: { message: errors[table] } }) }
      if (op === 'upsert') { writes.push({ table, rows: payload }); return resolve({ data: null, error: null }) }
      reads.push(table)
      const data = (tables[table] || []).filter((r) => filters.every((f) => {
        if (!Object.prototype.hasOwnProperty.call(r, f.col)) return true
        if (f.op === 'in') return f.vals.includes(r[f.col])
        return r[f.col] === f.val
      }))
      return resolve({ data, error: null })
    }
    return c
  }
  return { db: { from: (t) => chain(t) }, writes, reads }
}

const stages = (k) => [
  { role: 'new', slug: `${k}_new`, name: 'New' },
  { role: 'converted', slug: `${k}_converted`, name: 'Converted' },
]
const board = (key, entry, extra = {}) => ({
  id: `p-${key}`, key, module: 'offer', board_type: 'offer', mode: 'derived', enabled: true, priority: 10,
  config: { entry, stages: stages(key), duration_days: 14, ...extra },
})

const purchase = (id, contactId, over = {}) => ({
  id, location_id: LOC, contact_id: contactId, status: 'granted', payment_status: 'paid',
  paid_at: iso(T0 - 1000), granted_at: iso(T0), duration_days: 14, plan_code: null, landing_path: null, page_id: null, ...over,
})

describe('splitOfferBoards', () => {
  it('keeps enabled offer boards with a parsed config; skips and reports a bad one', () => {
    const good = board('o_reset', { type: 'tag', values: ['VIP'] })
    const bad = { ...board('o_broken', { type: 'tag', values: [] }) }
    const off = { ...board('o_off', { type: 'tag', values: ['x'] }), enabled: false }
    const acq = { id: 'a', key: 'acquisition', module: 'acquisition', board_type: null, enabled: true, config: {} }
    const { descriptors, skipped } = splitOfferBoards([good, bad, off, acq])
    expect(descriptors.map((b) => b.key)).toEqual(['o_reset'])
    expect(descriptors[0].entry).toEqual({ type: 'tag', values: ['vip'] })
    expect(skipped.map((s) => s.key)).toEqual(['o_broken'])
  })

  it('judges each board against its own module (un1t_product on offer, lead_source on offer_un1t)', () => {
    const un1tOnOffer = board('o_a', { type: 'un1t_product', values: ['p1'] })
    const leadOnUn1t = { ...board('o_b', { type: 'lead_source', values: ['meta'] }), module: 'offer_un1t' }
    const { descriptors, skipped } = splitOfferBoards([un1tOnOffer, leadOnUn1t])
    expect(descriptors).toEqual([])
    expect(skipped.map((s) => s.key)).toEqual(['o_a', 'o_b'])
  })
})

describe('trialPurchaseOfferConfigs module check', () => {
  it('drops a trial_purchase board whose module the entry does not suit', () => {
    const entry = { type: 'trial_purchase', match: 'plan_code', values: ['T39'] }
    const ok = board('o_ok', entry)
    const wrong = { ...board('o_wrong', entry), module: 'bogus_module' }
    expect(trialPurchaseOfferConfigs([ok, wrong]).map((b) => b.key)).toEqual(['o_ok'])
  })

  it('keeps a trial_purchase board of module offer_un1t', () => {
    const entry = { type: 'trial_purchase', match: 'plan_code', values: ['T39'] }
    const un1t = { ...board('o_un1t', entry), module: 'offer_un1t' }
    expect(trialPurchaseOfferConfigs([un1t]).map((b) => b.key)).toEqual(['o_un1t'])
  })
})

// PIPEBUILD.3g — the trial_purchase entries the €39 claim loaders leave out.
// PIPEBUILD.5c — an offer board switched on and not yet baselined is held on
// the event paths until the nightly pass has placed its qualifiers silently.
describe('placementDescriptors — baseline (PIPEBUILD.5c)', () => {
  const acq = { id: 'p-acq', key: 'acquisition', module: 'acquisition', mode: 'derived', enabled: true, board_type: null, priority: null, config: {} }
  const unbaselined = { ...board('o_x', { type: 'lead_source', values: ['x'] }), baseline_at: null }
  const absent = board('o_y', { type: 'lead_source', values: ['y'] })
  const baselined = { ...board('o_z', { type: 'lead_source', values: ['z'] }), baseline_at: '2026-11-01T00:00:00Z' }

  it('eventPathsHoldUnbaselinedBoard: by default an offer board with baseline_at null (or not read) is held, a baselined one placed', () => {
    const { descriptors, heldIds } = placementDescriptors([acq, unbaselined, absent, baselined])
    expect(descriptors.map((d) => d.key)).toEqual(['acquisition', 'o_z'])
    expect([...heldIds].sort()).toEqual(['p-o_x', 'p-o_y'])
  })
  it('holdUnbaselined false (the silent nightly pass only) gives the unbaselined board its descriptor', () => {
    const { descriptors, heldIds } = placementDescriptors([acq, unbaselined, baselined], { holdUnbaselined: false })
    expect(descriptors.map((d) => d.key)).toEqual(['acquisition', 'o_x', 'o_z'])
    expect(heldIds.size).toBe(0)
  })
  it('PIPEBUILD.3b: an offer_un1t board is never placed on an event path (held), even baselined with offers known', () => {
    const ou = { ...board('o_u', { type: 'corp_promo', values: ['acme'] }), module: 'offer_un1t', baseline_at: '2026-11-01T00:00:00Z' }
    const { descriptors, heldIds } = placementDescriptors([acq, baselined, ou])
    expect(descriptors.map((d) => d.key)).toEqual(['acquisition', 'o_z'])
    expect([...heldIds]).toEqual(['p-o_u'])
  })
  it('offers unknown still holds a baselined board', () => {
    const { descriptors, heldIds } = placementDescriptors([acq, baselined], { offersKnown: false, holdUnbaselined: false })
    expect(descriptors.map((d) => d.key)).toEqual(['acquisition'])
    expect([...heldIds]).toEqual(['p-o_z'])
  })
})

// PIPEBUILD.5m — an event path's first placement onto an offer board fires
// only on a claim that started at or after the board's baseline.
describe('offerPlacementSilence (PIPEBUILD.5m)', () => {
  const board = { baseline_at: iso(T0) }
  it('a claim at or after the baseline fires (null)', () => {
    expect(offerPlacementSilence(board, { claimedAt: iso(T0) })).toBeNull()
    expect(offerPlacementSilence(board, { claimedAt: iso(T0 + DAY) })).toBeNull()
  })
  it('a claim before the baseline is silent', () => {
    expect(offerPlacementSilence(board, { claimedAt: iso(T0 - 1) })).toBe('claim_before_baseline')
  })
  it('an unknown claim time is silent: no claim, no claimedAt, or an unreadable one', () => {
    expect(offerPlacementSilence(board, null)).toBe('claim_time_unknown')
    expect(offerPlacementSilence(board, { start: T0 + DAY })).toBe('claim_time_unknown')
    expect(offerPlacementSilence(board, { claimedAt: 'not a date' })).toBe('claim_time_unknown')
  })
  it('a board with no readable baseline is silent', () => {
    expect(offerPlacementSilence({ baseline_at: null }, { claimedAt: iso(T0) })).toBe('no_baseline')
    expect(offerPlacementSilence({}, { claimedAt: iso(T0) })).toBe('no_baseline')
  })
})

describe('offerPurchaseEntries / withoutOfferPurchases', () => {
  it('only enabled, parseable trial_purchase offer boards give an entry', () => {
    const trial = board('o_reset', { type: 'trial_purchase', match: 'plan_code', values: ['RESET14'] })
    const off = { ...board('o_off', { type: 'trial_purchase', match: 'plan_code', values: ['OFF'] }), enabled: false }
    const notOffer = { ...board('o_nb', { type: 'trial_purchase', match: 'plan_code', values: ['NB'] }), board_type: null }
    const broken = board('o_broken', { type: 'trial_purchase', match: 'nope', values: ['X'] })
    const tag = board('o_tagged', { type: 'tag', values: ['vip'] })
    expect(offerPurchaseEntries([trial, off, notOffer, broken, tag])).toEqual([{ type: 'trial_purchase', match: 'plan_code', values: ['RESET14'] }])
    expect(offerPurchaseEntries(null)).toEqual([])
  })
  it('drops matched purchases and hands back the same array when there is no entry', () => {
    const rows = [purchase('t1', 'c1', { plan_code: 'RESET14' }), purchase('t2', 'c1', { plan_code: 'EUR39' })]
    expect(withoutOfferPurchases(rows, [])).toBe(rows)
    expect(withoutOfferPurchases(rows, [{ type: 'trial_purchase', match: 'plan_code', values: ['RESET14'] }]).map((r) => r.id)).toEqual(['t2'])
  })
})

describe('loadOfferClaimsForLocation', () => {
  it('trialPurchaseByPlanCode', async () => {
    const boards = [board('o_reset', { type: 'trial_purchase', match: 'plan_code', values: ['RESET14'] })]
    const { db } = fakeDb({ trial_purchases: [
      purchase('t1', 'c1', { plan_code: 'RESET14' }),
      purchase('t2', 'c2', { plan_code: 'OTHER' }),
      purchase('t3', 'c3', { plan_code: 'RESET14', status: 'awaiting_payment', payment_status: null, paid_at: null, granted_at: null }),
    ] })
    const out = await loadOfferClaimsForLocation(db, { locationId: LOC, boards, contacts: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }], now: T0 })
    expect(out.ok).toBe(true)
    expect([...out.offersByContact.keys()]).toEqual(['c1'])
    expect(out.offersByContact.get('c1').get('o_reset')).toEqual({ start: T0, end: T0 + 14 * DAY, source: 'trial_purchase', claimedAt: iso(T0) })
    expect(out.pending).toEqual([])
  })
  it('trialPurchaseByLandingPath', async () => {
    const boards = [board('o_lp', { type: 'trial_purchase', match: 'landing_path', values: ['/50plus'] })]
    const { db } = fakeDb({ trial_purchases: [
      purchase('t1', 'c1', { landing_path: '/50plus' }),
      purchase('t2', 'c2', { landing_path: '/trial' }),
    ] })
    const out = await loadOfferClaimsForLocation(db, { locationId: LOC, boards, contacts: [{ id: 'c1' }, { id: 'c2' }], now: T0 })
    expect([...out.offersByContact.keys()]).toEqual(['c1'])
    expect(out.offersByContact.get('c1').get('o_lp').end).toBe(T0 + 14 * DAY)
  })
  it('boardDurationWins', async () => {
    // The board says 21 days; the purchase row says 7 (and another 14): the board wins.
    const boards = [board('o_lp', { type: 'trial_purchase', match: 'landing_path', values: ['/50plus'] }, { duration_days: 21 })]
    const { db } = fakeDb({ trial_purchases: [
      purchase('t1', 'c1', { landing_path: '/50plus', duration_days: 7 }),
      purchase('t2', 'c2', { landing_path: '/50plus', duration_days: 14 }),
    ] })
    const out = await loadOfferClaimsForLocation(db, { locationId: LOC, boards, contacts: [{ id: 'c1' }, { id: 'c2' }], now: T0 })
    expect(out.offersByContact.get('c1').get('o_lp')).toEqual({ start: T0, end: T0 + 21 * DAY, source: 'trial_purchase', claimedAt: iso(T0) })
    expect(out.offersByContact.get('c2').get('o_lp').end).toBe(T0 + 21 * DAY)
  })
  it('trialPurchaseByPageId', async () => {
    const boards = [board('o_pg', { type: 'trial_purchase', match: 'page_id', values: ['11111111-1111-1111-1111-111111111111'] })]
    const { db } = fakeDb({ trial_purchases: [
      purchase('t1', 'c1', { page_id: '11111111-1111-1111-1111-111111111111', granted_at: null, status: 'queued' }),
      purchase('t2', 'c2', { page_id: '22222222-2222-2222-2222-222222222222' }),
    ] })
    const out = await loadOfferClaimsForLocation(db, { locationId: LOC, boards, contacts: [{ id: 'c1' }, { id: 'c2' }], now: T0 })
    expect([...out.offersByContact.keys()]).toEqual(['c1'])
    expect(out.offersByContact.get('c1').get('o_pg').start).toBe(T0 - 1000)   // paid_at when never granted
    expect(out.offersByContact.get('c1').get('o_pg').claimedAt).toBe(iso(T0 - 1000))   // PIPEBUILD.5m
  })
  it('corpPromoGranted (the claim starts at created_at, never updated_at)', async () => {
    const boards = [board('o_corp', { type: 'corp_promo', values: ['acme'] }, { duration_days: 7 })]
    const { db } = fakeDb({ corp_promo_claims: [
      // a later edit moved updated_at on; the window still runs from created_at
      { id: 'k1', location_id: LOC, contact_id: 'c1', promo_key: 'acme', status: 'granted', created_at: iso(T0), updated_at: iso(T0 + 5 * DAY) },
      { id: 'k2', location_id: LOC, contact_id: 'c2', promo_key: 'acme', status: 'ineligible', created_at: iso(T0), updated_at: iso(T0) },
      { id: 'k3', location_id: LOC, contact_id: 'c3', promo_key: 'zeta', status: 'granted', created_at: iso(T0), updated_at: iso(T0) },
    ] })
    const out = await loadOfferClaimsForLocation(db, { locationId: LOC, boards, contacts: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }], now: T0 })
    expect([...out.offersByContact.keys()]).toEqual(['c1'])
    expect(out.offersByContact.get('c1').get('o_corp')).toEqual({ start: T0, end: T0 + 7 * DAY, source: 'corp_promo', claimedAt: iso(T0) })
  })
  it('leadSourceRecordedOnce', async () => {
    const boards = [board('o_lead', { type: 'lead_source', values: ['meta_x'] })]
    // PIPEBUILD.5m — every claim is dated by the contact's own times: a last
    // touch by last_lead_source_at (else created_at), the original lead_source
    // by created_at (it is set at creation), and `now` only with neither.
    const contacts = [
      { id: 'c1', last_lead_source: 'META_X', last_lead_source_at: iso(T0 - DAY), created_at: iso(T0 - 90 * DAY) },
      { id: 'c2', lead_source: 'meta_x', created_at: iso(T0 - 30 * DAY) },
      { id: 'c3', last_lead_source: 'other' },
      { id: 'c4', last_lead_source: 'meta_x', created_at: iso(T0 - 40 * DAY) },
      { id: 'c5', lead_source: 'meta_x' },
    ]
    const first = fakeDb({ pipeline_board_claims: [] })
    const out = await loadOfferClaimsForLocation(first.db, { locationId: LOC, boards, contacts, now: T0 })
    expect(out.pending).toEqual([
      { contact_id: 'c1', board_key: 'o_lead', claimed_at: iso(T0 - DAY), source: 'lead_source' },
      { contact_id: 'c2', board_key: 'o_lead', claimed_at: iso(T0 - 30 * DAY), source: 'lead_source' },
      { contact_id: 'c4', board_key: 'o_lead', claimed_at: iso(T0 - 40 * DAY), source: 'lead_source' },
      { contact_id: 'c5', board_key: 'o_lead', claimed_at: iso(T0), source: 'lead_source' },
    ])
    expect(out.offersByContact.get('c1').get('o_lead')).toEqual({ start: T0 - DAY, end: T0 - DAY + 14 * DAY, source: 'lead_source', claimedAt: iso(T0 - DAY) })
    // Second run: stored claims exist, nothing pending, claim unchanged.
    const second = fakeDb({ pipeline_board_claims: [
      { contact_id: 'c1', location_id: LOC, board_key: 'o_lead', claimed_at: iso(T0 - DAY), source: 'lead_source' },
      { contact_id: 'c2', location_id: LOC, board_key: 'o_lead', claimed_at: iso(T0 - 30 * DAY), source: 'lead_source' },
      { contact_id: 'c4', location_id: LOC, board_key: 'o_lead', claimed_at: iso(T0 - 40 * DAY), source: 'lead_source' },
      { contact_id: 'c5', location_id: LOC, board_key: 'o_lead', claimed_at: iso(T0), source: 'lead_source' },
    ] })
    const again = await loadOfferClaimsForLocation(second.db, { locationId: LOC, boards, contacts, now: T0 + 3 * DAY })
    expect(again.pending).toEqual([])
    expect(again.offersByContact.get('c1').get('o_lead').start).toBe(T0 - DAY)
    expect(second.writes).toEqual([])
  })
  it('glofoxPlanRecorded', async () => {
    const boards = [board('o_plan', { type: 'glofox_plan', values: ['elites trial'] })]
    const { db } = fakeDb({ pipeline_board_claims: [] })
    const out = await loadOfferClaimsForLocation(db, { locationId: LOC, boards, contacts: [{ id: 'c1', glofox_membership_plan: 'The Elites Trial' }, { id: 'c2', glofox_membership_plan: 'Elite Membership' }], now: T0 })
    expect(out.pending).toEqual([{ contact_id: 'c1', board_key: 'o_plan', claimed_at: iso(T0), source: 'glofox_plan' }])
    expect(out.offersByContact.get('c1').get('o_plan')).toEqual({ start: T0, end: T0 + 14 * DAY, source: 'glofox_plan', claimedAt: iso(T0) })
    expect(out.offersByContact.has('c2')).toBe(false)
  })
  it('tagRecorded', async () => {
    const boards = [board('o_tagged', { type: 'tag', values: ['vip'] })]
    const { db } = fakeDb({
      pipeline_board_claims: [],
      contact_tags: [
        { contact_id: 'c1', location_id: LOC, tag: 'VIP', added_at: iso(T0 - 2 * DAY), removed_at: null },
        { contact_id: 'c2', location_id: LOC, tag: 'vip', added_at: iso(T0), removed_at: iso(T0 + 1) },
        { contact_id: 'c3', location_id: LOC, tag: 'other', added_at: iso(T0), removed_at: null },
      ],
    })
    const out = await loadOfferClaimsForLocation(db, { locationId: LOC, boards, contacts: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }], now: T0 })
    expect(out.pending).toEqual([{ contact_id: 'c1', board_key: 'o_tagged', claimed_at: iso(T0 - 2 * DAY), source: 'tag' }])
    expect(out.offersByContact.get('c1').get('o_tagged').start).toBe(T0 - 2 * DAY)
    expect([...out.offersByContact.keys()]).toEqual(['c1'])
  })
  it('anyLoaderFailureFailsAll', async () => {
    const boards = [
      board('o_a', { type: 'trial_purchase', match: 'plan_code', values: ['X'] }),
      board('o_b', { type: 'corp_promo', values: ['acme'] }),
    ]
    const { db } = fakeDb({ trial_purchases: [purchase('t1', 'c1', { plan_code: 'X' })] }, { errors: { corp_promo_claims: 'boom' } })
    const out = await loadOfferClaimsForLocation(db, { locationId: LOC, boards, contacts: [{ id: 'c1' }], now: T0 })
    expect(out).toMatchObject({ ok: false, reason: 'promos_unreadable' })
    expect(out.offersByContact).toBeUndefined()
    const tags = fakeDb({ pipeline_board_claims: [] }, { errors: { contact_tags: 'boom' } })
    expect(await loadOfferClaimsForLocation(tags.db, { locationId: LOC, boards: [board('o_t', { type: 'tag', values: ['vip'] })], contacts: [{ id: 'c1' }], now: T0 }))
      .toMatchObject({ ok: false, reason: 'tags_unreadable' })
    const claims = fakeDb({}, { errors: { pipeline_board_claims: 'boom' } })
    expect(await loadOfferClaimsForLocation(claims.db, { locationId: LOC, boards: [board('o_l', { type: 'lead_source', values: ['x'] })], contacts: [{ id: 'c1' }], now: T0 }))
      .toMatchObject({ ok: false, reason: 'claims_unreadable' })
  })
  it('noOfferBoardsNoReads', async () => {
    const { db, reads } = fakeDb({})
    const out = await loadOfferClaimsForLocation(db, { locationId: LOC, boards: [{ id: 'a', key: 'acquisition', module: 'acquisition', enabled: true }], contacts: [{ id: 'c1' }], now: T0 })
    expect(out).toMatchObject({ ok: true, pending: [] })
    expect(out.offersByContact.size).toBe(0)
    expect(reads).toEqual([])
    // and only the table an active entry type uses is read
    const one = fakeDb({ corp_promo_claims: [] })
    await loadOfferClaimsForLocation(one.db, { locationId: LOC, boards: [board('o_b', { type: 'corp_promo', values: ['acme'] })], contacts: [{ id: 'c1' }], now: T0 })
    expect(one.reads).toEqual(['corp_promo_claims'])
  })
})

describe('recorded renewal windows', () => {
  const stored = (key, at) => [{ contact_id: 'c1', location_id: LOC, board_key: key, claimed_at: iso(at), source: 'lead_source' }]
  const C = T0
  const touch = (at) => ({ id: 'c1', last_lead_source: 'meta_x', last_lead_source_at: iso(at) })
  const run = (extra, touchAt, nowAt) => {
    const boards = [board('o_lead', { type: 'lead_source', values: ['meta_x'] }, extra)]
    const { db } = fakeDb({ pipeline_board_claims: stored('o_lead', C) })
    return loadOfferClaimsForLocation(db, { locationId: LOC, boards, contacts: [touch(touchAt)], now: nowAt })
  }
  it('lapsedLeadSourceRenewed (default windows)', async () => {
    // claim +14d end, +60d quiet -> live until C+74d; a touch at C+80d renews.
    const out = await run({}, C + 80 * DAY, C + 81 * DAY)
    expect(out.pending).toHaveLength(1)
    expect(out.offersByContact.get('c1').get('o_lead').start).toBe(C + 80 * DAY)
  })
  it('recordedRenewalUsesBoardWindows', async () => {
    // quiet_days 30: live until C+44d, so a touch at C+84d (40d after it lapsed) renews.
    const short = await run({ quiet_days: 30 }, C + 84 * DAY, C + 85 * DAY)
    expect(short.pending).toHaveLength(1)
    // quiet_days 90: still live until C+104d, the same touch must NOT renew.
    const long = await run({ quiet_days: 90 }, C + 84 * DAY, C + 85 * DAY)
    expect(long.pending).toEqual([])
    expect(long.offersByContact.get('c1').get('o_lead').start).toBe(C)
  })
})

describe('loadOfferClaimsForContact', () => {
  it('returns this contact\'s offers and records a pending claim when write is true', async () => {
    const boards = [board('o_lead', { type: 'lead_source', values: ['meta_x'] }), board('o_reset', { type: 'trial_purchase', match: 'plan_code', values: ['R'] })]
    const { db, writes } = fakeDb({
      pipeline_board_claims: [],
      trial_purchases: [purchase('t1', 'c1', { plan_code: 'R' }), purchase('t2', 'c9', { plan_code: 'R' })],
    })
    const contact = { id: 'c1', last_lead_source: 'meta_x', last_lead_source_at: iso(T0) }
    const out = await loadOfferClaimsForContact(db, { locationId: LOC, boards, contact, now: T0, write: true })
    expect(out.ok).toBe(true)
    expect([...out.offers.keys()].sort()).toEqual(['o_lead', 'o_reset'])
    expect(writes).toHaveLength(1)
    expect(writes[0].rows[0]).toMatchObject({ contact_id: 'c1', board_key: 'o_lead', source: 'lead_source' })
    const dry = fakeDb({ pipeline_board_claims: [] })
    await loadOfferClaimsForContact(dry.db, { locationId: LOC, boards: [boards[0]], contact, now: T0, write: false })
    expect(dry.writes).toEqual([])
  })
  it('a failed read is reported', async () => {
    const { db } = fakeDb({}, { errors: { trial_purchases: 'boom' } })
    const out = await loadOfferClaimsForContact(db, { locationId: LOC, boards: [board('o_r', { type: 'trial_purchase', match: 'plan_code', values: ['R'] })], contact: { id: 'c1' }, now: T0, write: false })
    expect(out).toMatchObject({ ok: false, reason: 'purchases_unreadable' })
  })
})

describe('programmeClaimsUnchanged', () => {
  it('the programme helpers still behave as before and still read only board_key programmes', async () => {
    const RULES = { lead_sources: ['meta_50plus'], glofox_plan_patterns: [] }
    expect(pendingProgrammeClaims([{ id: 'c1', last_lead_source: 'meta_50plus', last_lead_source_at: iso(T0) }], new Map(), RULES, T0)).toEqual([
      { contact_id: 'c1', board_key: 'programmes', claimed_at: iso(T0), source: 'lead_source' },
    ])
    const { db } = fakeDb({ trial_purchases: [], pipeline_board_claims: [
      { contact_id: 'c1', location_id: LOC, board_key: 'programmes', claimed_at: iso(T0), source: 'lead_source' },
      { contact_id: 'c1', location_id: LOC, board_key: 'o_lead', claimed_at: iso(T0 + 5), source: 'lead_source' },
    ] })
    const out = await loadClaimsForLocation(db, { locationId: LOC, contactIds: new Set(['c1']), now: T0 })
    expect(out.programmeByContact.get('c1')).toEqual({ claimedAt: T0, source: 'lead_source' })
  })
})

describe('un1t offer claims (PIPEBUILD.3b)', () => {
  const cfg = { duration_days: 14, entry: { type: 'un1t_product', values: ['AbC123'] } }
  const tx = (product_id, at, over = {}) => ({ product_id, refunded: false, remote_created_at: at, ...over })

  it('un1tProductOfferClaim: newest non-refunded matching row wins', () => {
    const c = un1tProductOfferClaim([
      tx('AbC123', iso(T0 - 3 * DAY)), tx('AbC123', iso(T0 - DAY)), tx('AbC123', iso(T0), { refunded: true }),
    ], cfg, T0)
    expect(c.start).toBe(T0 - DAY)
    expect(c.end - c.start).toBe(14 * DAY)
  })
  it('un1tProductOfferClaim: a later sub_renewal does not restart the claim', () => {
    const c = un1tProductOfferClaim([
      tx('AbC123', iso(T0 - 5 * DAY), { type: 'sub_initial' }), tx('AbC123', iso(T0), { type: 'sub_renewal' }),
    ], cfg, T0)
    expect(c.start).toBe(T0 - 5 * DAY)
  })
  it('un1tProductOfferClaim: a renewal alone is no claim', () => {
    expect(un1tProductOfferClaim([tx('AbC123', iso(T0), { type: 'sub_renewal' })], cfg, T0)).toBeNull()
  })
  it('un1tProductOfferClaim: a EUR 0 row counts, case is exact, no match is null', () => {
    expect(un1tProductOfferClaim([tx('AbC123', iso(T0), { amount_cents: 0 })], cfg, T0).start).toBe(T0)
    expect(un1tProductOfferClaim([tx('abc123', iso(T0))], cfg, T0)).toBeNull()
    expect(un1tProductOfferClaim([tx('AbC123', 'nope')], cfg, T0)).toBeNull()
    expect(un1tProductOfferClaim([], cfg, T0)).toBeNull()
  })

  const un1tBoard = (key, entry, extra = {}) => ({ ...board(key, entry, extra), module: 'offer_un1t' })
  const prodBoard = un1tBoard('o_prod', { type: 'un1t_product', values: ['AbC123'] })

  it('resolves an owner through un1t_clients and keys the claim by board key', async () => {
    const { db } = fakeDb({
      un1t_transactions: [
        { location_id: LOC, un1t_id: 't1', un1t_user_id: 'u1', contact_id: null, product_id: 'AbC123', refunded: false, remote_created_at: iso(T0) },
        { location_id: LOC, un1t_id: 't2', un1t_user_id: 'u9', contact_id: 'c-out', product_id: 'AbC123', refunded: false, remote_created_at: iso(T0) },
        { location_id: LOC, un1t_id: 't3', un1t_user_id: null, contact_id: null, product_id: 'AbC123', refunded: false, remote_created_at: iso(T0) },
      ],
      un1t_clients: [{ location_id: LOC, un1t_user_id: 'u1', contact_id: 'c1' }, { location_id: LOC, un1t_user_id: 'u8', contact_id: null }],
    })
    const res = await loadUn1tOfferClaims(db, { locationId: LOC, boards: [prodBoard], contactIds: ['c1'], now: T0 })
    expect(res.ok).toBe(true)
    const claim = res.offersByContact.get('c1').get('o_prod')
    expect(claim).toMatchObject({ start: T0, end: T0 + 14 * DAY, source: 'un1t_product', claimedAt: iso(T0) })
    expect(res.offersByContact.has('c-out')).toBe(false)
    expect(res.offersByContact.size).toBe(1)
  })

  it('a transactions read error is un1t_transactions_unreadable', async () => {
    const { db } = fakeDb({}, { errors: { un1t_transactions: 'boom' } })
    const res = await loadUn1tOfferClaims(db, { locationId: LOC, boards: [prodBoard], contactIds: ['c1'], now: T0 })
    expect(res).toMatchObject({ ok: false, reason: 'un1t_transactions_unreadable' })
  })

  it('a clients read error is un1t_clients_unreadable', async () => {
    const { db } = fakeDb({}, { errors: { un1t_clients: 'boom' } })
    const res = await loadUn1tOfferClaims(db, { locationId: LOC, boards: [prodBoard], contactIds: ['c1'], now: T0 })
    expect(res).toMatchObject({ ok: false, reason: 'un1t_clients_unreadable' })
  })

  it('disabled and non-offer_un1t boards are skipped and never read', async () => {
    const { db, reads } = fakeDb({})
    const res = await loadUn1tOfferClaims(db, {
      locationId: LOC, contactIds: ['c1'], now: T0,
      boards: [{ ...prodBoard, enabled: false }, board('o_plain', { type: 'un1t_product', values: ['x'] })],
    })
    expect(res.ok).toBe(true)
    expect(reads).toEqual([])
    expect(res.offersByContact.size).toBe(0)
    expect(res.skipped.map((s) => s.key)).toContain('o_plain')
  })

  it('a trial_purchase offer_un1t board reads trial_purchases like the contacts path', async () => {
    const { db } = fakeDb({ trial_purchases: [purchase('p1', 'c1', { plan_code: 'PLAN' })] })
    const b = un1tBoard('o_tp', { type: 'trial_purchase', match: 'plan_code', values: ['PLAN'] })
    const res = await loadUn1tOfferClaims(db, { locationId: LOC, boards: [b], contactIds: ['c1'], now: T0 })
    expect(res.ok).toBe(true)
    expect(res.offersByContact.get('c1').get('o_tp')).toMatchObject({ source: 'trial_purchase', start: T0 })
  })
})
