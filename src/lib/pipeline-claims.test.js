// PIPE3.5 — the claims IO behind the router: trial_purchases rows (the paid
// claim) and pipeline_board_claims rows (the recorded programme claim).
import { describe, it, expect, vi } from 'vitest'
import {
  programmeRulesFromSettings, loadBoardsForLocation, loadClaimsForLocation, pendingProgrammeClaims,
  upsertProgrammeClaims, loadClaimsForContact, loadProgrammeRules,
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
      const data = apply(tables[table])
      if (op === 'single') return resolve({ data: data[0] ?? null, error: null })
      return resolve({ data, error: null })
    }
    return c
  }
  return { db: { from: (t) => chain(t) }, writes }
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
  it('renews a stored claim when the lead-source touch is newer; leaves an older one', () => {
    const stored = new Map([['c1', { claimedAt: T0 - 86_400_000, source: 'glofox_plan' }]])
    expect(pendingProgrammeClaims([fresh], stored, RULES, T0 + 1000)).toEqual([
      { contact_id: 'c1', board_key: 'programmes', claimed_at: iso(T0), source: 'lead_source' },
    ])
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
