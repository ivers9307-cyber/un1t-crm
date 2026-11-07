// PIPE3.5 — the claims IO behind the router: trial_purchases rows (the paid
// claim) and pipeline_board_claims rows (the recorded programme claim).
import { describe, it, expect, vi } from 'vitest'
import {
  programmeRulesFromSettings, loadBoardsForLocation, loadClaimsForLocation, pendingProgrammeClaims,
  upsertProgrammeClaims, loadClaimsForContact, loadProgrammeRules, loadPlacementClaims,
  placementPackGuard, loadPackGuardForContact,
} from './pipeline-claims.js'

vi.mock('./log.js', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

const T0 = Date.parse('2026-10-31T22:28:37Z')
const iso = (ms) => new Date(ms).toISOString()
const LOC = 'a0000000-0000-0000-0000-000000000001'
const RULES = { lead_sources: ['meta_50plus'], glofox_plan_patterns: ['elites trial'] }

// A fluent shim: rows per table, equality/in filters honoured when the row
// carries the column, error injection per table, upserts logged.
function fakeDb(tables = {}, { errors = {} } = {}) {
  const writes = []
  const reads = []
  function chain(table) {
    const filters = []
    let op = 'select'
    let payload = null
    let onConflict = null
    const c = {}
    c.select = () => c
    c.order = () => c
    c.range = () => c
    c.limit = () => c
    c.maybeSingle = () => { op = op === 'select' ? 'single' : op; return c }
    c.eq = (col, val) => { filters.push({ op: 'eq', col, val }); return c }
    c.in = (col, vals) => { filters.push({ op: 'in', col, vals }); return c }
    c.upsert = (rows, opts) => { op = 'upsert'; payload = rows; onConflict = opts?.onConflict; return c }
    const apply = (rows) => (rows || []).filter((r) => filters.every((f) => {
      if (!r || !Object.prototype.hasOwnProperty.call(r, f.col)) return true
      return f.op === 'in' ? f.vals.includes(r[f.col]) : r[f.col] === f.val
    }))
    c.then = (resolve) => {
      if (errors[table]) return resolve({ data: null, error: { message: errors[table] } })
      if (op === 'upsert') {
        writes.push({ table, rows: payload, onConflict })
        return resolve({ data: null, error: null })
      }
      reads.push(table)
      const data = apply(tables[table])
      if (op === 'single') return resolve({ data: data[0] ?? null, error: null })
      return resolve({ data, error: null })
    }
    return c
  }
  return { db: { from: (t) => chain(t) }, writes, reads }
}

describe('programmeRulesFromSettings', () => {
  it('reads settings.pipelines.programmes, lower-cased and trimmed, empties dropped', () => {
    expect(programmeRulesFromSettings({ pipelines: { programmes: { lead_sources: [' META_50plus ', ''], glofox_plan_patterns: ['Elites Trial', 7] } } }))
      .toEqual({ lead_sources: ['meta_50plus'], glofox_plan_patterns: ['elites trial'] })
  })
  it('absent or malformed settings give empty lists', () => {
    expect(programmeRulesFromSettings(null)).toEqual({ lead_sources: [], glofox_plan_patterns: [] })
    expect(programmeRulesFromSettings({ pipelines: 'nope' })).toEqual({ lead_sources: [], glofox_plan_patterns: [] })
    expect(programmeRulesFromSettings({ pipelines: { programmes: { lead_sources: 'meta_50plus' } } })).toEqual({ lead_sources: [], glofox_plan_patterns: [] })
  })
})

describe('loadBoardsForLocation', () => {
  it('returns the enabled rows at the location', async () => {
    const { db } = fakeDb({ pipelines: [
      { id: 'p1', location_id: LOC, key: 'acquisition', module: 'acquisition', mode: 'derived', enabled: true, is_primary: true },
      { id: 'p2', location_id: LOC, key: 'returning', module: 'returning', mode: 'derived', enabled: false, is_primary: false },
      { id: 'p3', location_id: 'other', key: 'acquisition', module: 'acquisition', mode: 'derived', enabled: true, is_primary: true },
    ] })
    const out = await loadBoardsForLocation(db, LOC)
    expect(out.ok).toBe(true)
    expect(out.boards.map((b) => b.id)).toEqual(['p1'])
  })
  it('a read error is boards_unreadable', async () => {
    const { db } = fakeDb({}, { errors: { pipelines: 'boom' } })
    expect(await loadBoardsForLocation(db, LOC)).toEqual({ ok: false, reason: 'boards_unreadable', err: 'boom' })
  })
  it('PIPEBUILD.5o: names the switched-off OFFER boards from the same read; a switched-off built-in board is not one', async () => {
    const { db, reads } = fakeDb({ pipelines: [
      { id: 'p1', location_id: LOC, key: 'acquisition', module: 'acquisition', mode: 'derived', enabled: true, is_primary: true, board_type: null },
      { id: 'p2', location_id: LOC, key: 'paid_trial', module: 'paid_trial', mode: 'derived', enabled: false, is_primary: false, board_type: null },
      { id: 'p3', location_id: LOC, key: 'o_corp', module: 'offer', mode: 'derived', enabled: false, is_primary: false, board_type: 'offer' },
      { id: 'p4', location_id: 'other', key: 'o_x', module: 'offer', mode: 'derived', enabled: false, is_primary: false, board_type: 'offer' },
    ] })
    const out = await loadBoardsForLocation(db, LOC)
    expect(out.boards.map((b) => b.id)).toEqual(['p1'])
    expect(out.disabledOfferIds).toEqual(['p3'])
    expect(reads.filter((t) => t === 'pipelines')).toHaveLength(1)
  })
  it('PIPEBUILD.5o: no switched-off offer board, no disabledOfferIds key (exactly today)', async () => {
    const { db } = fakeDb({ pipelines: [
      { id: 'p1', location_id: LOC, key: 'acquisition', module: 'acquisition', mode: 'derived', enabled: true, is_primary: true, board_type: null },
      { id: 'p2', location_id: LOC, key: 'paid_trial', module: 'paid_trial', mode: 'derived', enabled: false, is_primary: false, board_type: null },
    ] })
    const out = await loadBoardsForLocation(db, LOC)
    expect(out).toEqual({ ok: true, boards: [expect.objectContaining({ id: 'p1' })] })
  })
})

describe('loadClaimsForLocation', () => {
  const purchases = [
    { id: 'tp1', location_id: LOC, contact_id: 'c1', status: 'granted', payment_status: 'paid', paid_at: iso(T0 - 1000), granted_at: iso(T0), duration_days: 14 },
    { id: 'tp2', location_id: LOC, contact_id: 'c9', status: 'granted', payment_status: 'paid', paid_at: iso(T0), granted_at: iso(T0), duration_days: 14 },
    { id: 'tp3', location_id: LOC, contact_id: 'c2', status: 'awaiting_payment', payment_status: null, paid_at: null, granted_at: null, duration_days: 14 },
  ]
  const claimRows = [
    { contact_id: 'c2', location_id: LOC, board_key: 'programmes', claimed_at: iso(T0 - 5000), source: 'lead_source' },
    { contact_id: 'c9', location_id: LOC, board_key: 'programmes', claimed_at: iso(T0), source: 'glofox_plan' },
  ]
  it('keeps only the given contacts; a paid claim per contact, a programme claim per contact', async () => {
    const { db } = fakeDb({ trial_purchases: purchases, pipeline_board_claims: claimRows })
    const out = await loadClaimsForLocation(db, { locationId: LOC, contactIds: new Set(['c1', 'c2']), now: T0 })
    expect(out.ok).toBe(true)
    expect([...out.paidByContact.keys()]).toEqual(['c1'])
    expect(out.paidByContact.get('c1')).toMatchObject({ start: T0 })
    expect([...out.programmeByContact.keys()]).toEqual(['c2'])
    expect(out.programmeByContact.get('c2')).toEqual({ claimedAt: T0 - 5000, source: 'lead_source' })
  })
  it('an unpaid purchase is not a claim', async () => {
    const { db } = fakeDb({ trial_purchases: purchases, pipeline_board_claims: [] })
    const out = await loadClaimsForLocation(db, { locationId: LOC, contactIds: new Set(['c2']), now: T0 })
    expect(out.paidByContact.size).toBe(0)
  })
  it('a failed purchases read is purchases_unreadable; a failed claims read is claims_unreadable', async () => {
    expect(await loadClaimsForLocation(fakeDb({}, { errors: { trial_purchases: 'tp down' } }).db, { locationId: LOC, contactIds: new Set(['c1']), now: T0 }))
      .toMatchObject({ ok: false, reason: 'purchases_unreadable' })
    expect(await loadClaimsForLocation(fakeDb({ trial_purchases: [] }, { errors: { pipeline_board_claims: 'cl down' } }).db, { locationId: LOC, contactIds: new Set(['c1']), now: T0 }))
      .toMatchObject({ ok: false, reason: 'claims_unreadable' })
  })
})

describe('pendingProgrammeClaims (pure)', () => {
  const fresh = { id: 'c1', last_lead_source: 'meta_50plus', last_lead_source_at: iso(T0) }
  it('a new meta_50plus match yields a row dated at last_lead_source_at', () => {
    expect(pendingProgrammeClaims([fresh], new Map(), RULES, T0 + 1000)).toEqual([
      { contact_id: 'c1', board_key: 'programmes', claimed_at: iso(T0), source: 'lead_source' },
    ])
  })
  it('renews a LAPSED claim when a newer lead-source touch arrives; never resets a LIVE one (review #3)', () => {
    // Lapsed: claimed 100 days ago, no class, no payment → the second /50plus signup re-opens it.
    const lapsed = new Map([['c1', { claimedAt: T0 - 100 * 86_400_000, source: 'glofox_plan' }]])
    expect(pendingProgrammeClaims([fresh], lapsed, RULES, T0 + 1000)).toEqual([
      { contact_id: 'c1', board_key: 'programmes', claimed_at: iso(T0), source: 'lead_source' },
    ])
    // Live: claimed a day ago → a re-submission must not move 1st Class Done back to Lead.
    const live = new Map([['c1', { claimedAt: T0 - 86_400_000, source: 'glofox_plan' }]])
    expect(pendingProgrammeClaims([{ ...fresh, last_attended_at: iso(T0 - 3600_000) }], live, RULES, T0 + 1000)).toEqual([])
    const newer = new Map([['c1', { claimedAt: T0 + 500, source: 'lead_source' }]])
    expect(pendingProgrammeClaims([fresh], newer, RULES, T0 + 1000)).toEqual([])
  })
  it('a plan match with a stored claim yields nothing (a plan carries no date); a new plan match is dated now', () => {
    const elites = { id: 'c2', glofox_membership_plan: 'The Elites Trial' }
    expect(pendingProgrammeClaims([elites], new Map([['c2', { claimedAt: T0 - 1, source: 'glofox_plan' }]]), RULES, T0)).toEqual([])
    expect(pendingProgrammeClaims([elites], new Map(), RULES, T0)).toEqual([
      { contact_id: 'c2', board_key: 'programmes', claimed_at: iso(T0), source: 'glofox_plan' },
    ])
  })
  it('Elite Membership and unrelated sources yield nothing', () => {
    expect(pendingProgrammeClaims([{ id: 'c3', glofox_membership_plan: 'Elite Membership' }, { id: 'c4', last_lead_source: 'meta_trial' }], new Map(), RULES, T0)).toEqual([])
  })
})

describe('upsertProgrammeClaims', () => {
  it('upserts on contact_id,location_id,board_key with location_id and updated_at stamped', async () => {
    const { db, writes } = fakeDb()
    const rows = [{ contact_id: 'c1', board_key: 'programmes', claimed_at: iso(T0), source: 'lead_source' }]
    const out = await upsertProgrammeClaims(db, LOC, rows, T0)
    expect(out).toEqual({ ok: true, written: 1 })
    expect(writes).toHaveLength(1)
    expect(writes[0].onConflict).toBe('contact_id,location_id,board_key')
    expect(writes[0].rows[0]).toMatchObject({ contact_id: 'c1', location_id: LOC, board_key: 'programmes', claimed_at: iso(T0), source: 'lead_source', updated_at: iso(T0) })
  })
  it('nothing to write is ok with 0 written and no call', async () => {
    const { db, writes } = fakeDb()
    expect(await upsertProgrammeClaims(db, LOC, [], T0)).toEqual({ ok: true, written: 0 })
    expect(writes).toHaveLength(0)
  })
  it('a failed upsert is reported, never thrown', async () => {
    const { db } = fakeDb({}, { errors: { pipeline_board_claims: 'nope' } })
    expect(await upsertProgrammeClaims(db, LOC, [{ contact_id: 'c1', board_key: 'programmes', claimed_at: iso(T0), source: 'lead_source' }], T0))
      .toEqual({ ok: false, written: 0, error: 'nope' })
  })
})

describe('loadProgrammeRules', () => {
  it('reads the location settings', async () => {
    const { db } = fakeDb({ locations: [{ id: LOC, settings: { pipelines: { programmes: RULES } } }] })
    expect(await loadProgrammeRules(db, LOC)).toEqual({ ok: true, rules: RULES })
  })
  it('a read error is settings_unreadable; a missing row gives empty rules', async () => {
    expect(await loadProgrammeRules(fakeDb({}, { errors: { locations: 'x' } }).db, LOC)).toMatchObject({ ok: false, reason: 'settings_unreadable' })
    expect(await loadProgrammeRules(fakeDb({ locations: [] }).db, LOC)).toEqual({ ok: true, rules: { lead_sources: [], glofox_plan_patterns: [] } })
  })
})

describe('loadClaimsForContact', () => {
  const contact = { id: 'c1', location_id: LOC, last_lead_source: 'meta_50plus', last_lead_source_at: iso(T0) }
  it('reads this contact\'s purchases and claim; writes the pending programme claim when write is true', async () => {
    const { db, writes } = fakeDb({
      trial_purchases: [{ id: 'tp1', location_id: LOC, contact_id: 'c1', status: 'granted', payment_status: 'paid', paid_at: iso(T0), granted_at: iso(T0), duration_days: 14 }],
      pipeline_board_claims: [],
    })
    const out = await loadClaimsForContact(db, { locationId: LOC, contactId: 'c1', contact, now: T0 + 1000, rules: RULES, write: true })
    expect(out.ok).toBe(true)
    expect(out.claims.paid).toMatchObject({ start: T0 })
    expect(out.claims.programme).toEqual({ claimedAt: T0, source: 'lead_source' })
    expect(writes).toHaveLength(1)
    expect(writes[0].rows[0]).toMatchObject({ contact_id: 'c1', location_id: LOC, board_key: 'programmes' })
  })
  it('write false: the pending claim is returned but not written', async () => {
    const { db, writes } = fakeDb({ trial_purchases: [], pipeline_board_claims: [] })
    const out = await loadClaimsForContact(db, { locationId: LOC, contactId: 'c1', contact, now: T0, rules: RULES, write: false })
    expect(out.claims.programme).toEqual({ claimedAt: T0, source: 'lead_source' })
    expect(writes).toHaveLength(0)
  })
  it('a stored claim is returned as is when nothing renews it', async () => {
    const { db, writes } = fakeDb({ trial_purchases: [], pipeline_board_claims: [{ contact_id: 'c1', location_id: LOC, board_key: 'programmes', claimed_at: iso(T0 + 5000), source: 'lead_source' }] })
    const out = await loadClaimsForContact(db, { locationId: LOC, contactId: 'c1', contact, now: T0 + 9000, rules: RULES, write: true })
    expect(out.claims.programme).toEqual({ claimedAt: T0 + 5000, source: 'lead_source' })
    expect(writes).toHaveLength(0)
  })
  it('a failed read is reported with its reason; a failed claim write still returns the claim', async () => {
    expect(await loadClaimsForContact(fakeDb({}, { errors: { trial_purchases: 'x' } }).db, { locationId: LOC, contactId: 'c1', contact, now: T0, rules: RULES }))
      .toMatchObject({ ok: false, reason: 'purchases_unreadable' })
    const { db } = fakeDb({ trial_purchases: [] }, { errors: { pipeline_board_claims: 'cl' } })
    expect(await loadClaimsForContact(db, { locationId: LOC, contactId: 'c1', contact, now: T0, rules: RULES }))
      .toMatchObject({ ok: false, reason: 'claims_unreadable' })
  })
})

describe('loadPlacementClaims', () => {
  const ACQ = { id: 'p1', location_id: LOC, key: 'acquisition', module: 'acquisition', mode: 'derived', enabled: true, is_primary: true }
  const PAID = { id: 'p2', location_id: LOC, key: 'paid_trial', module: 'paid_trial', mode: 'derived', enabled: true, is_primary: false }
  const contact = { id: 'c1', location_id: LOC }
  it('acquisition alone: boards only, no claims, no further reads', async () => {
    const { db } = fakeDb({ pipelines: [ACQ] }, { errors: { trial_purchases: 'must not be read', locations: 'must not be read' } })
    expect(await loadPlacementClaims(db, { locationId: LOC, contactId: 'c1', contact, now: T0 })).toEqual({ ok: true, boards: [ACQ], claimBoards: false, claims: null })
  })
  it('a claim board present: rules and claims are read', async () => {
    const { db } = fakeDb({
      pipelines: [ACQ, PAID], locations: [{ id: LOC, settings: {} }],
      trial_purchases: [{ id: 'tp1', location_id: LOC, contact_id: 'c1', status: 'granted', payment_status: 'paid', paid_at: iso(T0), granted_at: iso(T0), duration_days: 14 }],
      pipeline_board_claims: [],
    })
    const out = await loadPlacementClaims(db, { locationId: LOC, contactId: 'c1', contact, now: T0 })
    expect(out.ok).toBe(true)
    expect(out.claimBoards).toBe(true)
    expect(out.claims.paid).toMatchObject({ start: T0 })
    expect(out.claims.programme).toBeNull()
  })
  it('PIPEBUILD.5o: the switched-off offer boards ride along, with or without claim boards', async () => {
    const OFF = { id: 'p9', location_id: LOC, key: 'o_corp', module: 'offer', mode: 'derived', enabled: false, is_primary: false, board_type: 'offer' }
    expect(await loadPlacementClaims(fakeDb({ pipelines: [ACQ, OFF] }).db, { locationId: LOC, contactId: 'c1', contact, now: T0 }))
      .toEqual({ ok: true, boards: [ACQ], claimBoards: false, claims: null, disabledOfferIds: ['p9'] })
    const withPaid = await loadPlacementClaims(fakeDb({ pipelines: [ACQ, PAID, OFF], locations: [{ id: LOC, settings: {} }], trial_purchases: [], pipeline_board_claims: [] }).db,
      { locationId: LOC, contactId: 'c1', contact, now: T0 })
    expect(withPaid).toMatchObject({ ok: true, claimBoards: true, disabledOfferIds: ['p9'] })
    expect(withPaid.boards.map((b) => b.id)).toEqual(['p1', 'p2'])
  })
  it('a failed boards, settings or purchases read is reported with its reason', async () => {
    expect(await loadPlacementClaims(fakeDb({}, { errors: { pipelines: 'x' } }).db, { locationId: LOC, contactId: 'c1', contact, now: T0 })).toEqual({ ok: false, reason: 'boards_unreadable' })
    expect(await loadPlacementClaims(fakeDb({ pipelines: [ACQ, PAID] }, { errors: { locations: 'x' } }).db, { locationId: LOC, contactId: 'c1', contact, now: T0 })).toMatchObject({ ok: false, reason: 'settings_unreadable' })
    expect(await loadPlacementClaims(fakeDb({ pipelines: [ACQ, PAID], locations: [] }, { errors: { trial_purchases: 'x' } }).db, { locationId: LOC, contactId: 'c1', contact, now: T0 })).toMatchObject({ ok: false, reason: 'purchases_unreadable' })
  })
})

// PIPEBUILD.3e — an offer board is a claim board for a single placement: its
// claims ride along as claims.offers (Map<boardKey, claim>).
describe('loadPlacementClaims — offer boards (PIPEBUILD.3e)', () => {
  const ACQ = { id: 'p1', location_id: LOC, key: 'acquisition', module: 'acquisition', mode: 'derived', enabled: true, is_primary: true, board_type: null }
  const PAID = { id: 'p2', location_id: LOC, key: 'paid_trial', module: 'paid_trial', mode: 'derived', enabled: true, is_primary: false, board_type: null }
  const CORP = {
    id: 'p3', location_id: LOC, key: 'o_corp', module: 'offer', mode: 'derived', enabled: true, is_primary: false, board_type: 'offer', baseline_at: '2026-01-01T00:00:00Z', priority: 10,
    config: {
      entry: { type: 'corp_promo', values: ['acme'] },
      stages: [{ role: 'new', slug: 'o_corp_new', name: 'New' }, { role: 'converted', slug: 'o_corp_converted', name: 'Converted' }],
      duration_days: 14,
    },
  }
  const contact = { id: 'c1', location_id: LOC }
  const promo = { id: 'cp1', location_id: LOC, contact_id: 'c1', promo_key: 'acme', status: 'granted', created_at: iso(T0), updated_at: iso(T0) }

  it('an offer board alone is a claim board: its claims are read, the €39/Programmes tables are not', async () => {
    const { db } = fakeDb(
      { pipelines: [ACQ, CORP], locations: [{ id: LOC, membership_source: 'glofox' }], corp_promo_claims: [promo] },
      { errors: { trial_purchases: 'must not be read', pipeline_board_claims: 'must not be read' } },
    )
    const out = await loadPlacementClaims(db, { locationId: LOC, contactId: 'c1', contact, now: T0 })
    expect(out.ok).toBe(true)
    expect(out.claimBoards).toBe(true)
    expect(out.claims.paid).toBeNull()
    expect(out.claims.programme).toBeNull()
    expect(out.claims.offers).toBeInstanceOf(Map)
    expect(out.claims.offers.get('o_corp')).toMatchObject({ start: T0, source: 'corp_promo' })
  })

  it('beside a €39 board both kinds are read', async () => {
    const { db } = fakeDb({
      pipelines: [ACQ, PAID, CORP], locations: [{ id: LOC, settings: {}, membership_source: 'glofox' }], corp_promo_claims: [promo],
      trial_purchases: [{ id: 'tp1', location_id: LOC, contact_id: 'c1', status: 'granted', payment_status: 'paid', paid_at: iso(T0), granted_at: iso(T0), duration_days: 14 }],
      pipeline_board_claims: [],
    })
    const out = await loadPlacementClaims(db, { locationId: LOC, contactId: 'c1', contact, now: T0 })
    expect(out.claims.paid).toMatchObject({ start: T0 })
    expect(out.claims.offers.get('o_corp')).toMatchObject({ start: T0 })
  })

  it('without an offer board the claims keep today\'s shape (no offers key)', async () => {
    const { db } = fakeDb({ pipelines: [ACQ, PAID], locations: [{ id: LOC, settings: {} }], trial_purchases: [], pipeline_board_claims: [] })
    const out = await loadPlacementClaims(db, { locationId: LOC, contactId: 'c1', contact, now: T0 })
    expect(Object.keys(out.claims).sort()).toEqual(['paid', 'programme'])
  })

  it('at a un1t.online studio the offer boards are refused: offers null, no promo read', async () => {
    const { db } = fakeDb(
      { pipelines: [ACQ, CORP], locations: [{ id: LOC, membership_source: 'un1t_online' }] },
      { errors: { corp_promo_claims: 'must not be read' } },
    )
    const out = await loadPlacementClaims(db, { locationId: LOC, contactId: 'c1', contact, now: T0 })
    expect(out).toMatchObject({ ok: true, claimBoards: true, offersRefused: 'un1t_online_studio' })
    expect(out.claims.offers).toBeNull()
  })

  it('an unreadable membership source holds the offer boards (offers null), never guesses', async () => {
    const { db } = fakeDb({ pipelines: [ACQ, CORP], corp_promo_claims: [promo] }, { errors: { locations: 'down' } })
    const out = await loadPlacementClaims(db, { locationId: LOC, contactId: 'c1', contact, now: T0 })
    expect(out).toMatchObject({ ok: true, offersRefused: 'membership_source_unreadable' })
    expect(out.claims.offers).toBeNull()
  })

  it('a failed offer claim read is reported with its reason', async () => {
    const { db } = fakeDb({ pipelines: [ACQ, CORP], locations: [{ id: LOC, membership_source: 'glofox' }] }, { errors: { corp_promo_claims: 'x' } })
    expect(await loadPlacementClaims(db, { locationId: LOC, contactId: 'c1', contact, now: T0 })).toMatchObject({ ok: false, reason: 'promos_unreadable' })
  })
})

// PIPEBUILD.3g — a purchase an enabled trial_purchase offer board matches is
// that board's claim, never also a €39 paid claim: else, when the offer claim
// lapses first, the buyer drops onto the €39 board and its sequences.
describe('offer-matched purchases are not €39 paid claims (PIPEBUILD.3g)', () => {
  const ACQ = { id: 'p1', location_id: LOC, key: 'acquisition', module: 'acquisition', mode: 'derived', enabled: true, is_primary: true, board_type: null }
  const PAID = { id: 'p2', location_id: LOC, key: 'paid_trial', module: 'paid_trial', mode: 'derived', enabled: true, is_primary: false, board_type: null }
  const RESET = {
    id: 'p3', location_id: LOC, key: 'o_reset', module: 'offer', mode: 'derived', enabled: true, is_primary: false, board_type: 'offer', baseline_at: '2026-01-01T00:00:00Z', priority: 50,
    config: {
      entry: { type: 'trial_purchase', match: 'plan_code', values: ['RESET14'] },
      stages: [{ role: 'new', slug: 'o_reset_new', name: 'New' }, { role: 'converted', slug: 'o_reset_converted', name: 'Converted' }],
      duration_days: 10,
    },
  }
  const TAGGED = { ...RESET, id: 'p4', key: 'o_tagged', config: { ...RESET.config, entry: { type: 'tag', values: ['vip'] } } }
  const buy = (id, contactId, planCode, at = T0) => ({
    id, location_id: LOC, contact_id: contactId, status: 'granted', payment_status: 'paid',
    paid_at: iso(at), granted_at: iso(at), duration_days: 14, plan_code: planCode, landing_path: null, page_id: null,
  })
  const contact = { id: 'c1', location_id: LOC }

  it('offerMatchedPurchaseNotAPaidClaim (nightly)', async () => {
    const { db } = fakeDb({ trial_purchases: [buy('t1', 'c1', 'RESET14'), buy('t2', 'c2', 'EUR39')], pipeline_board_claims: [] })
    const out = await loadClaimsForLocation(db, { locationId: LOC, contactIds: new Set(['c1', 'c2']), now: T0, offerBoards: [RESET] })
    expect(out.ok).toBe(true)
    expect(out.paidByContact.has('c1')).toBe(false)
    expect(out.paidByContact.get('c2')).toMatchObject({ start: T0 })
  })

  it('offerMatchedPurchaseNotAPaidClaim (single contact)', async () => {
    const { db } = fakeDb({ trial_purchases: [buy('t1', 'c1', 'RESET14')], pipeline_board_claims: [] })
    const out = await loadClaimsForContact(db, { locationId: LOC, contactId: 'c1', contact, now: T0, rules: RULES, write: false, offerBoards: [RESET] })
    expect(out.claims.paid).toBeNull()
    // the claim over every purchase rides along for the Class Pack guard
    expect(out.purchasePaid).toMatchObject({ start: T0 })

    const placed = fakeDb({
      pipelines: [ACQ, PAID, RESET], locations: [{ id: LOC, settings: {}, membership_source: 'glofox' }],
      trial_purchases: [buy('t1', 'c1', 'RESET14')], pipeline_board_claims: [],
    })
    const res = await loadPlacementClaims(placed.db, { locationId: LOC, contactId: 'c1', contact, now: T0, write: false })
    expect(res.ok).toBe(true)
    expect(res.claims.paid).toBeNull()
    expect(res.claims.offers.get('o_reset')).toMatchObject({ start: T0, end: T0 + 10 * 86_400_000, source: 'trial_purchase' })
    expect(res.purchasePaid).toMatchObject({ start: T0 })
  })

  // AUDIT.2 — a trial_purchase offer board switched on and NOT yet baselined is
  // held on every event path (PIPEBUILD.5c), so it takes nothing out of the €39
  // claim here: the buyer keeps their €39 claim and stays on the €39 board
  // until the nightly pass moves them silently. Before this a current €39
  // buyer read as a Class Pack member on the next webhook.
  it('unbaselinedOfferBoardLeavesThePaidClaimAlone (event path)', async () => {
    const UNBASED = { ...RESET, baseline_at: null }
    const placed = fakeDb({
      pipelines: [ACQ, PAID, UNBASED], locations: [{ id: LOC, settings: {}, membership_source: 'glofox' }],
      trial_purchases: [buy('t1', 'c1', 'RESET14')], pipeline_board_claims: [],
    })
    const res = await loadPlacementClaims(placed.db, { locationId: LOC, contactId: 'c1', contact, now: T0, write: false })
    expect(res.ok).toBe(true)
    expect(res.claims.paid).toMatchObject({ start: T0 })
    // no offer claims were loaded for a board nothing here will place
    expect(res.claims.offers).toBeUndefined()
    expect('purchasePaid' in res).toBe(false)
  })

  it('an unbaselined offer board beside a baselined one: only the baselined one strips', async () => {
    const UNBASED_TAG = { ...TAGGED, baseline_at: null }
    const placed = fakeDb({
      pipelines: [ACQ, PAID, RESET, UNBASED_TAG], locations: [{ id: LOC, settings: {}, membership_source: 'glofox' }],
      trial_purchases: [buy('t1', 'c1', 'RESET14')], pipeline_board_claims: [], contact_tags: [],
    })
    const res = await loadPlacementClaims(placed.db, { locationId: LOC, contactId: 'c1', contact, now: T0, write: false })
    expect(res.ok).toBe(true)
    expect(res.claims.paid).toBeNull()
    expect(res.claims.offers.get('o_reset')).toMatchObject({ source: 'trial_purchase' })
    expect(res.claims.offers.has('o_tagged')).toBe(false)
  })

  it('unmatchedPurchaseStillPaid', async () => {
    const rows = [buy('t1', 'c1', 'EUR39')]
    const nightly = await loadClaimsForLocation(fakeDb({ trial_purchases: rows, pipeline_board_claims: [] }).db, { locationId: LOC, contactIds: new Set(['c1']), now: T0, offerBoards: [RESET] })
    expect(nightly.paidByContact.get('c1')).toMatchObject({ start: T0 })
    const single = await loadClaimsForContact(fakeDb({ trial_purchases: rows, pipeline_board_claims: [] }).db, { locationId: LOC, contactId: 'c1', contact, now: T0, rules: RULES, write: false, offerBoards: [RESET] })
    expect(single.claims.paid).toMatchObject({ start: T0 })
    // an older offer purchase beside a newer €39 one: the €39 one is the paid claim
    const both = await loadClaimsForLocation(fakeDb({ trial_purchases: [buy('t0', 'c1', 'RESET14', T0 + 1000), buy('t1', 'c1', 'EUR39')], pipeline_board_claims: [] }).db,
      { locationId: LOC, contactIds: new Set(['c1']), now: T0 + 2000, offerBoards: [RESET] })
    expect(both.paidByContact.get('c1')).toMatchObject({ start: T0 })
  })

  it('noOfferBoardPaidClaimsUnchanged', async () => {
    const rows = [buy('t1', 'c1', 'RESET14')]
    for (const offerBoards of [undefined, null, [], [TAGGED], [{ ...RESET, enabled: false }], [{ ...RESET, board_type: null }]]) {
      const { db, reads } = fakeDb({ trial_purchases: rows, pipeline_board_claims: [] })
      const nightly = await loadClaimsForLocation(db, { locationId: LOC, contactIds: new Set(['c1']), now: T0, offerBoards })
      expect(nightly.paidByContact.get('c1')).toMatchObject({ start: T0 })
      expect(reads).toEqual(['trial_purchases', 'pipeline_board_claims'])
      const one = fakeDb({ trial_purchases: rows, pipeline_board_claims: [] })
      const single = await loadClaimsForContact(one.db, { locationId: LOC, contactId: 'c1', contact, now: T0, rules: RULES, write: false, offerBoards })
      expect(Object.keys(single).sort()).toEqual(['claims', 'ok'])
      expect(single.claims.paid).toMatchObject({ start: T0 })
      expect(one.reads).toEqual(['trial_purchases', 'pipeline_board_claims'])
    }
    // a studio with no offer board: loadPlacementClaims has no purchasePaid key
    const { db } = fakeDb({ pipelines: [ACQ, PAID], locations: [{ id: LOC, settings: {} }], trial_purchases: rows, pipeline_board_claims: [] })
    const out = await loadPlacementClaims(db, { locationId: LOC, contactId: 'c1', contact, now: T0, write: false })
    expect('purchasePaid' in out).toBe(false)
    expect(out.claims.paid).toMatchObject({ start: T0 })
  })

  it('a refused studio\'s offer boards take nothing out of the €39 claim', async () => {
    const { db } = fakeDb({
      pipelines: [ACQ, PAID, RESET], locations: [{ id: LOC, settings: {}, membership_source: 'un1t_online' }],
      trial_purchases: [buy('t1', 'c1', 'RESET14')], pipeline_board_claims: [],
    })
    const out = await loadPlacementClaims(db, { locationId: LOC, contactId: 'c1', contact, now: T0, write: false })
    expect(out.offersRefused).toBe('un1t_online_studio')
    expect(out.claims.paid).toMatchObject({ start: T0 })
    expect('purchasePaid' in out).toBe(false)
  })
})

// PIPEBUILD.3b — offer_un1t boards are placed by the hourly un1t pass only:
// a single-contact path never loads them, and offersRefused names the `offer`
// boards a un1t.online studio refuses.
describe('loadPlacementClaims — offer_un1t boards (PIPEBUILD.3b)', () => {
  const ACQ = { id: 'p1', location_id: LOC, key: 'acquisition', module: 'acquisition', mode: 'derived', enabled: true, is_primary: true, board_type: null }
  const CORP = {
    id: 'p3', location_id: LOC, key: 'o_corp', module: 'offer', mode: 'derived', enabled: true, is_primary: false, board_type: 'offer', baseline_at: '2026-01-01T00:00:00Z', priority: 10,
    config: {
      entry: { type: 'corp_promo', values: ['acme'] },
      stages: [{ role: 'new', slug: 'o_corp_new', name: 'New' }, { role: 'converted', slug: 'o_corp_converted', name: 'Converted' }],
      duration_days: 14,
    },
  }
  const OU = {
    ...CORP, id: 'p4', key: 'o_u', module: 'offer_un1t',
    config: { ...CORP.config, stages: [{ role: 'new', slug: 'o_u_new', name: 'New' }, { role: 'converted', slug: 'o_u_converted', name: 'Converted' }] },
  }
  const contact = { id: 'c1', location_id: LOC }
  const promo = { id: 'cp1', location_id: LOC, contact_id: 'c1', promo_key: 'acme', status: 'granted', created_at: iso(T0), updated_at: iso(T0) }

  it('an offer_un1t board at a un1t.online studio is not loaded and sets no offersRefused (no source read, no claim read)', async () => {
    const { db, reads } = fakeDb(
      { pipelines: [ACQ, OU], locations: [{ id: LOC, membership_source: 'un1t_online' }], corp_promo_claims: [promo] },
      { errors: { corp_promo_claims: 'must not be read', un1t_transactions: 'must not be read' } },
    )
    const out = await loadPlacementClaims(db, { locationId: LOC, contactId: 'c1', contact, now: T0 })
    expect(out).toMatchObject({ ok: true, claimBoards: false, claims: null })
    expect(out).not.toHaveProperty('offersRefused')
    expect(reads).toEqual(['pipelines'])
  })

  it('beside an offer board at a un1t.online studio only the offer board is refused (un1t_online_studio)', async () => {
    const { db } = fakeDb(
      { pipelines: [ACQ, CORP, OU], locations: [{ id: LOC, membership_source: 'un1t_online' }] },
      { errors: { corp_promo_claims: 'must not be read' } },
    )
    const out = await loadPlacementClaims(db, { locationId: LOC, contactId: 'c1', contact, now: T0 })
    expect(out).toMatchObject({ ok: true, claimBoards: true, offersRefused: 'un1t_online_studio' })
    expect(out.claims.offers).toBeNull()
  })

  it('beside an offer board at a Glofox studio only the offer board\'s claims are loaded', async () => {
    const { db, reads } = fakeDb(
      { pipelines: [ACQ, CORP, OU], locations: [{ id: LOC, membership_source: 'glofox' }], corp_promo_claims: [promo] },
      { errors: { un1t_transactions: 'must not be read' } },
    )
    const out = await loadPlacementClaims(db, { locationId: LOC, contactId: 'c1', contact, now: T0 })
    expect(out).toMatchObject({ ok: true, claimBoards: true })
    expect(out).not.toHaveProperty('offersRefused')
    expect([...out.claims.offers.keys()]).toEqual(['o_corp'])
    expect(reads).not.toContain('un1t_transactions')
  })
})

// PIPEBUILD.3h — an unreadable studio setting places nobody beside a
// trial_purchase offer board; the Class Pack guard follows the offer window.
describe('PIPEBUILD.3h — unreadable source and the pack guard', () => {
  const DAY = 86_400_000
  const ACQ = { id: 'p1', location_id: LOC, key: 'acquisition', module: 'acquisition', mode: 'derived', enabled: true, is_primary: true, board_type: null }
  const PAID = { id: 'p2', location_id: LOC, key: 'paid_trial', module: 'paid_trial', mode: 'derived', enabled: true, is_primary: false, board_type: null }
  const RESET = {
    id: 'p3', location_id: LOC, key: 'o_reset', module: 'offer', mode: 'derived', enabled: true, is_primary: false, board_type: 'offer', baseline_at: '2026-01-01T00:00:00Z', priority: 50,
    config: {
      entry: { type: 'trial_purchase', match: 'plan_code', values: ['RESET14'] },
      stages: [{ role: 'new', slug: 'o_reset_new', name: 'New' }, { role: 'converted', slug: 'o_reset_converted', name: 'Converted' }],
      duration_days: 90,
    },
  }
  const CORP = { ...RESET, id: 'p4', key: 'o_corp', config: { ...RESET.config, entry: { type: 'corp_promo', values: ['acme'] } } }
  const buy = (at, planCode = 'RESET14') => ({
    id: 't1', location_id: LOC, contact_id: 'c1', status: 'granted', payment_status: 'paid',
    paid_at: iso(at), granted_at: iso(at), duration_days: 14, plan_code: planCode, landing_path: null, page_id: null,
  })
  const contact = { id: 'c1', location_id: LOC }

  it('unreadableSourceWithTrialPurchaseOfferPlacesNobody (event path): claims unreadable, nothing past the source read', async () => {
    for (const pipelines of [[ACQ, PAID, RESET], [ACQ, RESET], [ACQ, PAID, RESET, CORP]]) {
      const { db, reads } = fakeDb({ pipelines, trial_purchases: [buy(T0)], pipeline_board_claims: [] }, { errors: { locations: 'down' } })
      const out = await loadPlacementClaims(db, { locationId: LOC, contactId: 'c1', contact, now: T0, write: false })
      expect(out).toMatchObject({ ok: false, reason: 'membership_source_unreadable' })
      expect(reads).toEqual(['pipelines'])
    }
  })

  it('unreadableSourceWithoutTrialPurchaseOfferHoldsOnly (event path): the offer boards are held, the €39 claim still reads', async () => {
    const { db } = fakeDb({ pipelines: [ACQ, PAID, CORP], trial_purchases: [buy(T0, 'EUR39')], pipeline_board_claims: [] }, { errors: { locations: 'down' } })
    // The programme settings live on `locations` too: only the FIRST locations
    // read (the membership source) fails here.
    const settings = fakeDb({ locations: [{ id: LOC, settings: {} }] }).db
    let locationReads = 0
    const sourceDown = { from: (t) => (t === 'locations' && locationReads++ > 0 ? settings.from(t) : db.from(t)) }
    const out = await loadPlacementClaims(sourceDown, { locationId: LOC, contactId: 'c1', contact, now: T0, write: false })
    expect(out).toMatchObject({ ok: true, offersRefused: 'membership_source_unreadable' })
    expect(out.claims.offers).toBeNull()
    expect(out.claims.paid).toMatchObject({ start: T0 })
    // a un1t.online answer beside a trial_purchase board still only holds the
    // offer boards: a deliberate answer, not an unknown
    const un1t = fakeDb({ pipelines: [ACQ, PAID, RESET], locations: [{ id: LOC, settings: {}, membership_source: 'un1t_online' }], trial_purchases: [buy(T0)], pipeline_board_claims: [] })
    const held = await loadPlacementClaims(un1t.db, { locationId: LOC, contactId: 'c1', contact, now: T0, write: false })
    expect(held).toMatchObject({ ok: true, offersRefused: 'un1t_online_studio' })
    expect(held.claims.paid).toMatchObject({ start: T0 })
  })

  it('packGuardAtStudioWithOnlyOfferBoard: the claim over every purchase rides along; a failed purchases read fails the call', async () => {
    const { db } = fakeDb({ pipelines: [ACQ, RESET], locations: [{ id: LOC, membership_source: 'glofox' }], trial_purchases: [buy(T0)], pipeline_board_claims: [] })
    const out = await loadPlacementClaims(db, { locationId: LOC, contactId: 'c1', contact, now: T0, write: false })
    expect(out.ok).toBe(true)
    expect(out.claims.paid).toBeNull()
    expect(out.purchasePaid).toMatchObject({ start: T0, durationDays: 14 })
    expect(placementPackGuard(out, contact, T0)).toBe(true)
    // AUDIT.2 — the same board switched on and not yet baselined: it strips
    // nothing and loads no offer claim (nothing on this path places it), but
    // the guard still sees every purchase, so the trial's credits never stamp
    // a Class Pack.
    const fresh = fakeDb({ pipelines: [ACQ, { ...RESET, baseline_at: null }], locations: [{ id: LOC, membership_source: 'glofox' }], trial_purchases: [buy(T0)], pipeline_board_claims: [] })
    const freshOut = await loadPlacementClaims(fresh.db, { locationId: LOC, contactId: 'c1', contact, now: T0, write: false })
    expect(freshOut).toMatchObject({ ok: true, claimBoards: true })
    expect(freshOut.claims.paid).toBeNull()
    expect(freshOut.claims.offers).toBeUndefined()
    expect(freshOut.purchasePaid).toMatchObject({ start: T0, durationDays: 14 })
    expect(placementPackGuard(freshOut, contact, T0)).toBe(true)
    const down = fakeDb({ pipelines: [ACQ, RESET], locations: [{ id: LOC, membership_source: 'glofox' }] }, { errors: { trial_purchases: 'x' } })
    expect(await loadPlacementClaims(down.db, { locationId: LOC, contactId: 'c1', contact, now: T0, write: false })).toMatchObject({ ok: false, reason: 'purchases_unreadable' })
    // a corp_promo offer board alone reads no purchases (no trial_purchase entry)
    const corp = fakeDb({ pipelines: [ACQ, CORP], locations: [{ id: LOC, membership_source: 'glofox' }], corp_promo_claims: [] }, { errors: { trial_purchases: 'must not be read' } })
    const corpOut = await loadPlacementClaims(corp.db, { locationId: LOC, contactId: 'c1', contact, now: T0, write: false })
    expect(corpOut.ok).toBe(true)
    expect('purchasePaid' in corpOut).toBe(false)
  })

  it('packGuardHonoursLongerOfferWindow: day 80 of a 14-day row on a 90-day board (placement guard)', async () => {
    const now = T0 + 80 * DAY
    const { db } = fakeDb({ pipelines: [ACQ, PAID, RESET], locations: [{ id: LOC, settings: {}, membership_source: 'glofox' }], trial_purchases: [buy(T0)], pipeline_board_claims: [] })
    const out = await loadPlacementClaims(db, { locationId: LOC, contactId: 'c1', contact, now, write: false })
    expect(out.ok).toBe(true)
    // the €39 claim over every purchase lapsed at day 74 (14 + 60 quiet)…
    expect(placementPackGuard({ ...out, claims: { ...out.claims, offers: new Map() } }, contact, now)).toBe(false)
    // …the offer claim (90 days) is live: the guard holds
    expect(out.claims.offers.get('o_reset')).toMatchObject({ start: T0, end: T0 + 90 * DAY })
    expect(placementPackGuard(out, contact, now)).toBe(true)
    // past the offer's own quiet window it lapses too
    expect(placementPackGuard(out, contact, T0 + 151 * DAY)).toBe(false)
  })

  it('placementPackGuard with no offer board is exactly claimLive(claims.paid)', () => {
    const paid = { start: T0, end: T0 + 14 * DAY }
    expect(placementPackGuard({ ok: true, boards: [ACQ, PAID], claimBoards: true, claims: { paid, programme: null } }, contact, T0 + DAY)).toBe(true)
    expect(placementPackGuard({ ok: true, boards: [ACQ, PAID], claimBoards: true, claims: { paid, programme: null } }, contact, T0 + 80 * DAY)).toBe(false)
    expect(placementPackGuard({ ok: true, boards: [ACQ, PAID], claimBoards: true, claims: { paid: null, programme: null } }, contact, T0)).toBe(false)
  })

  it('packGuardHonoursLongerOfferWindow (skip-placement): loadPackGuardForContact', async () => {
    const now = T0 + 80 * DAY
    // a live €39 claim: one read, live
    const live = fakeDb({ trial_purchases: [buy(T0, 'EUR39')] }, { errors: { pipelines: 'must not be read' } })
    expect(await loadPackGuardForContact(live.db, { locationId: LOC, contactId: 'c1', contact, now: T0 + DAY })).toEqual({ ok: true, live: true })
    expect(live.reads).toEqual(['trial_purchases'])
    // no purchase: one read, not live
    const none = fakeDb({ trial_purchases: [] }, { errors: { pipelines: 'must not be read' } })
    expect(await loadPackGuardForContact(none.db, { locationId: LOC, contactId: 'c1', contact, now })).toEqual({ ok: true, live: false })
    expect(none.reads).toEqual(['trial_purchases'])
    // a lapsed €39 claim, the 90-day offer board holds it
    const long = fakeDb({ trial_purchases: [buy(T0)], pipelines: [ACQ, PAID, RESET] })
    expect(await loadPackGuardForContact(long.db, { locationId: LOC, contactId: 'c1', contact, now })).toEqual({ ok: true, live: true })
    expect(long.reads).toEqual(['trial_purchases', 'pipelines'])
    // the same purchase at a studio with no offer board (or a non-matching plan): not live
    for (const [pipelines, plan] of [[[ACQ, PAID], 'RESET14'], [[ACQ, PAID, RESET], 'EUR39'], [[ACQ, PAID, CORP], 'RESET14']]) {
      const no = fakeDb({ trial_purchases: [buy(T0, plan)], pipelines })
      expect(await loadPackGuardForContact(no.db, { locationId: LOC, contactId: 'c1', contact, now })).toEqual({ ok: true, live: false })
    }
    // a failed boards or purchases read: { ok: false } (the caller keeps the guard live)
    expect(await loadPackGuardForContact(fakeDb({ trial_purchases: [buy(T0)] }, { errors: { pipelines: 'x' } }).db, { locationId: LOC, contactId: 'c1', contact, now })).toEqual({ ok: false, reason: 'boards_unreadable' })
    expect(await loadPackGuardForContact(fakeDb({}, { errors: { trial_purchases: 'x' } }).db, { locationId: LOC, contactId: 'c1', contact, now })).toEqual({ ok: false, reason: 'purchases_unreadable' })
  })
})
