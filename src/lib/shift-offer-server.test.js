// src/lib/shift-offer-server.test.js
// REPLACE.1b — the DB half: the leased sender (never loses a notice,
// duplicates at worst), closing, the */5 sweep, create / withdraw / claim.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { scriptedDb, chainsFor, argsOf, allArgsOf } from './scripted-db.test-helpers'
import { collectSchema, parseSelect } from '../../scripts/check-select-columns.mjs'

vi.mock('./push-dedup', () => ({ notifyUsersOnce: vi.fn(async () => ({ sent: 1, emailed: 0, failed: 0 })) }))
vi.mock('./push', () => ({ readRoleRecipientIds: vi.fn(async () => ({ ids: ['mgr', 'c1'], error: null })) }))
vi.mock('./candidates-data', () => ({ loadBlockCandidates: vi.fn() }))
vi.mock('./log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
const { notifyUsersOnce } = await import('./push-dedup')
const { readRoleRecipientIds } = await import('./push')
const { loadBlockCandidates } = await import('./candidates-data')
const { logError, logWarn } = await import('./log')
const {
  processOffer, runShiftOfferSweep, createOffer, withdrawOffer, claimOffer, readOffer, listOpenOffers, SWEEP_LIMIT,
  OFFER_SELECT, BLOCK_SELECT,
} = await import('./shift-offer-server')

const BLOCK = {
  id: 'b1', location_id: 'loc-1', block_date: '2026-09-29', start_time: '06:00:00', end_time: '07:00:00',
  min_coaches: 1, max_coaches: 3, rosters: { status: 'published' }, shift_templates: { name: 'Morning', kind: 'class', start_time: '06:00:00', end_time: '07:00:00' }, shift_assignments: [],
}
const IN_BAND = Date.parse('2026-09-28T10:00:00Z')
const QUIET = Date.parse('2026-09-28T22:30:00Z')
const OFFER = {
  id: 'o1', location_id: 'loc-1', block_id: 'b1', status: 'open', offered_by: 'mgr', broadcast_at: null,
  notice_attempts: 0, notice_lease_until: null, shift_blocks: BLOCK, locations: { name: 'Studio North', timezone: 'Europe/Dublin' },
}
const CHECKED = { shifts: true, cross_studio: true, leave: true, availability: true }
const ANSWER = { error: null, checked: CHECKED, candidates: [
  { profile_id: 'mgr', tier: 'ready' }, { profile_id: 'c1', tier: 'ready' }, { profile_id: 'c2', tier: 'blocked', on_leave: { type: 'holiday' } },
] }
const ok = { data: [{ id: 'o1' }], error: null }
const none = { data: [], error: null }

beforeEach(() => {
  vi.clearAllMocks()
  notifyUsersOnce.mockResolvedValue({ sent: 1, emailed: 0, failed: 0 })
  readRoleRecipientIds.mockResolvedValue({ ids: ['mgr', 'c1'], error: null })
  loadBlockCandidates.mockResolvedValue(ANSWER)
})

describe('processOffer — the broadcast', () => {
  it('lease (guarded), CANDIDATES.1\'s audience, send under the attempt key, stamp (guarded on status + attempt)', async () => {
    const db = scriptedDb({ shift_offers: [ok, ok] })
    expect(await processOffer(db, OFFER, { nowMs: IN_BAND })).toBe('sent')
    const [lease, stamp] = chainsFor(db, 'shift_offers')
    expect(argsOf(lease, 'update')[0]).toEqual({ notice_lease_until: '2026-09-28T10:10:00.000Z', notice_attempts: 1 })
    expect(allArgsOf(lease, 'eq')).toEqual([['id', 'o1'], ['status', 'open'], ['notice_attempts', 0]])
    expect(argsOf(lease, 'or')).toEqual(['notice_lease_until.is.null,notice_lease_until.lt.2026-09-28T10:00:00.000Z'])
    // Review 4 — published shifts only: nobody is skipped over a draft they cannot see.
    expect(loadBlockCandidates).toHaveBeenCalledWith(db, { block: { ...BLOCK, location_id: 'loc-1' }, audience: 'manager', publishedShiftsOnly: true })
    // c2 is on leave (blocked), mgr posted it: only c1.
    expect(notifyUsersOnce).toHaveBeenCalledWith(db, 'shift_offer_broadcast:o1:a1', ['c1'], expect.objectContaining({ category: 'swap', data: expect.objectContaining({ type: 'shift_offer' }) }))
    expect(argsOf(stamp, 'update')[0]).toEqual({ broadcast_at: '2026-09-28T10:00:00.000Z', broadcast_count: 1, broadcast_outcome: 'sent', notice_lease_until: null })
    expect(allArgsOf(stamp, 'eq')).toEqual([['id', 'o1'], ['status', 'open'], ['notice_attempts', 1]])
  })
  it('a retry after an expired lease uses the NEXT attempt number and a NEW ledger key', async () => {
    const db = scriptedDb({ shift_offers: [ok, ok] })
    await processOffer(db, { ...OFFER, notice_attempts: 2, notice_lease_until: '2026-09-28T09:55:00Z' }, { nowMs: IN_BAND })
    expect(allArgsOf(chainsFor(db, 'shift_offers')[0], 'eq')).toEqual([['id', 'o1'], ['status', 'open'], ['notice_attempts', 2]])
    expect(notifyUsersOnce.mock.calls[0][1]).toBe('shift_offer_broadcast:o1:a3')
  })
  it('someone else holds the lease: nothing is read or sent', async () => {
    const db = scriptedDb({ shift_offers: [none] })
    expect(await processOffer(db, OFFER, { nowMs: IN_BAND })).toBe('busy')
    expect(loadBlockCandidates).not.toHaveBeenCalled()
    expect(notifyUsersOnce).not.toHaveBeenCalled()
  })
  it('quiet hours: no read, no write', async () => {
    expect(await processOffer(scriptedDb({}), OFFER, { nowMs: QUIET })).toBe('quiet_hours')
    expect(loadBlockCandidates).not.toHaveBeenCalled()
  })
  it('an unreadable or unchecked candidates answer releases the lease and tells nobody (retried next tick)', async () => {
    for (const answer of [{ error: { message: 'down' } }, { ...ANSWER, checked: { ...CHECKED, leave: false } }]) {
      vi.clearAllMocks()
      loadBlockCandidates.mockResolvedValue(answer)
      const db = scriptedDb({ shift_offers: [ok, ok] })
      expect(await processOffer(db, OFFER, { nowMs: IN_BAND })).toBe('retry')
      expect(notifyUsersOnce).not.toHaveBeenCalled()
      const release = chainsFor(db, 'shift_offers')[1]
      expect(argsOf(release, 'update')[0]).toEqual({ notice_lease_until: null })
      expect(allArgsOf(release, 'eq')).toEqual([['id', 'o1'], ['status', 'open'], ['notice_attempts', 1]])
    }
  })
  it('a send that failed outright releases the lease; a partial one stamps', async () => {
    notifyUsersOnce.mockResolvedValueOnce({ sent: 0, emailed: 0, failed: 1 })
    let db = scriptedDb({ shift_offers: [ok, ok] })
    expect(await processOffer(db, OFFER, { nowMs: IN_BAND })).toBe('retry')
    expect(argsOf(chainsFor(db, 'shift_offers')[1], 'update')[0]).toEqual({ notice_lease_until: null })
    notifyUsersOnce.mockResolvedValueOnce({ sent: 1, emailed: 0, failed: 1 })
    db = scriptedDb({ shift_offers: [ok, ok] })
    expect(await processOffer(db, OFFER, { nowMs: IN_BAND })).toBe('sent')
    expect(argsOf(chainsFor(db, 'shift_offers')[1], 'update')[0]).toMatchObject({ broadcast_outcome: 'sent' })
  })
  it('an email fallback counts as delivered', async () => {
    notifyUsersOnce.mockResolvedValueOnce({ sent: 0, emailed: 1, failed: 1 })
    const db = scriptedDb({ shift_offers: [ok, ok] })
    expect(await processOffer(db, OFFER, { nowMs: IN_BAND })).toBe('sent')
  })
  it('nobody eligible: stamped no_recipients, count 0, nothing sent', async () => {
    loadBlockCandidates.mockResolvedValue({ ...ANSWER, candidates: [{ profile_id: 'mgr', tier: 'ready' }] })
    const db = scriptedDb({ shift_offers: [ok, ok] })
    expect(await processOffer(db, OFFER, { nowMs: IN_BAND })).toBe('sent')
    expect(notifyUsersOnce).not.toHaveBeenCalled()
    expect(argsOf(chainsFor(db, 'shift_offers')[1], 'update')[0]).toMatchObject({ broadcast_count: 0, broadcast_outcome: 'no_recipients' })
  })
  it('a lost stamp is logged and reported; the expired lease re-sends under a NEW key (duplicate, never loss)', async () => {
    const db = scriptedDb({ shift_offers: [ok, { data: null, error: { message: 'stamp failed' } }] })
    expect(await processOffer(db, OFFER, { nowMs: IN_BAND })).toBe('stamp_failed')
    expect(logError).toHaveBeenCalledWith('shift-offer', expect.stringMatching(/stamp/), expect.anything())
  })
  it('a stamp that matched nothing (the offer moved on while sending) is a warning, not a fault', async () => {
    const db = scriptedDb({ shift_offers: [ok, none] })
    expect(await processOffer(db, OFFER, { nowMs: IN_BAND })).toBe('sent')
    expect(logWarn).toHaveBeenCalledWith('shift-offer', expect.stringMatching(/changed before the stamp/), expect.anything())
  })
  it('a failed lease write throws (the arm counts it)', async () => {
    const db = scriptedDb({ shift_offers: [{ data: null, error: { message: 'lease write failed' } }] })
    await expect(processOffer(db, OFFER, { nowMs: IN_BAND })).rejects.toThrow(/lease write failed/)
  })
  it('too many attempts: gives up loudly, stamped gave_up', async () => {
    const db = scriptedDb({ shift_offers: [ok] })
    expect(await processOffer(db, { ...OFFER, notice_attempts: 5 }, { nowMs: IN_BAND })).toBe('gave_up')
    const [c] = chainsFor(db, 'shift_offers')
    expect(argsOf(c, 'update')[0]).toEqual({ broadcast_at: '2026-09-28T10:00:00.000Z', broadcast_outcome: 'gave_up', notice_lease_until: null })
    expect(allArgsOf(c, 'eq')).toEqual([['id', 'o1'], ['status', 'open']])
    expect(argsOf(c, 'is')).toEqual(['broadcast_at', null])
    expect(logError).toHaveBeenCalled()
  })
  it('a failed give-up write throws (retried next tick)', async () => {
    const db = scriptedDb({ shift_offers: [{ data: null, error: { message: 'down' } }] })
    await expect(processOffer(db, { ...OFFER, notice_attempts: 5 }, { nowMs: IN_BAND })).rejects.toThrow(/down/)
  })
})

describe('processOffer — closing and the taken notice', () => {
  it('a started shift closes as expired, guarded on still open, at any hour', async () => {
    const db = scriptedDb({ shift_offers: [ok] })
    expect(await processOffer(db, OFFER, { nowMs: Date.parse('2026-09-29T05:00:00Z') })).toBe('expired')
    const [c] = chainsFor(db, 'shift_offers')
    expect(argsOf(c, 'update')[0]).toEqual({ status: 'expired', closed_at: '2026-09-29T05:00:00.000Z', notice_lease_until: null })
    expect(allArgsOf(c, 'eq')).toEqual([['id', 'o1'], ['status', 'open']])
  })
  it('a shift that got its coach another way closes as filled in quiet hours too', async () => {
    const db = scriptedDb({ shift_offers: [ok] })
    expect(await processOffer(db, { ...OFFER, shift_blocks: { ...BLOCK, shift_assignments: [{ profile_id: 'x', status: 'scheduled' }] } }, { nowMs: QUIET })).toBe('filled')
  })
  it('a close that lost the race reports raced', async () => {
    const db = scriptedDb({ shift_offers: [none] })
    expect(await processOffer(db, { ...OFFER, shift_blocks: { ...BLOCK, shift_assignments: [{ profile_id: 'x', status: 'scheduled' }] } }, { nowMs: QUIET })).toBe('raced')
  })
  it('claimed: the studio\'s managers minus the claimant, taken payload, stamped taken_notified_at', async () => {
    const claimed = { ...OFFER, status: 'claimed', claimed_by: 'c1', claimed_at: '2026-09-28T09:59:00Z', taken_notified_at: null, claimer: { full_name: 'Coach B' } }
    const db = scriptedDb({ shift_offers: [ok, ok] })
    expect(await processOffer(db, claimed, { nowMs: IN_BAND })).toBe('sent')
    expect(readRoleRecipientIds).toHaveBeenCalledWith(db, 'loc-1', expect.arrayContaining(['manager', 'owner']))
    expect(notifyUsersOnce).toHaveBeenCalledWith(db, 'shift_offer_taken:o1:a1', ['mgr'], expect.objectContaining({ title: 'Offered shift taken', body: 'Coach B took Morning, Tue 29 Sep, 06:00 to 07:00.' }))
    expect(allArgsOf(chainsFor(db, 'shift_offers')[0], 'eq')).toEqual([['id', 'o1'], ['status', 'claimed'], ['notice_attempts', 0]])
    const stamp = chainsFor(db, 'shift_offers')[1]
    expect(argsOf(stamp, 'update')[0]).toEqual({ taken_notified_at: '2026-09-28T10:00:00.000Z', notice_lease_until: null })
    expect(allArgsOf(stamp, 'eq')).toEqual([['id', 'o1'], ['status', 'claimed'], ['notice_attempts', 1]])
    expect(loadBlockCandidates).not.toHaveBeenCalled()
  })
  it('review 1 — a failed managers read releases the lease and NEVER stamps (the managers\' only signal)', async () => {
    readRoleRecipientIds.mockResolvedValueOnce({ ids: [], error: { message: 'down' } })
    const claimed = { ...OFFER, status: 'claimed', claimed_by: 'c1', claimed_at: '2026-09-28T09:59:00Z', taken_notified_at: null }
    const db = scriptedDb({ shift_offers: [ok, ok] })
    expect(await processOffer(db, claimed, { nowMs: IN_BAND })).toBe('retry')
    expect(notifyUsersOnce).not.toHaveBeenCalled()
    const release = chainsFor(db, 'shift_offers')[1]
    expect(argsOf(release, 'update')[0]).toEqual({ notice_lease_until: null })
    expect(chainsFor(db, 'shift_offers').some((c) => argsOf(c, 'update')?.[0]?.taken_notified_at)).toBe(false)
  })

  it('claimed more than 24 h ago and never told: gives up (stamped), never a stale message', async () => {
    const claimed = { ...OFFER, status: 'claimed', claimed_by: 'c1', claimed_at: '2026-09-27T09:00:00Z', taken_notified_at: null }
    const db = scriptedDb({ shift_offers: [ok] })
    expect(await processOffer(db, claimed, { nowMs: IN_BAND })).toBe('gave_up')
    expect(argsOf(chainsFor(db, 'shift_offers')[0], 'update')[0]).toEqual({ taken_notified_at: '2026-09-28T10:00:00.000Z', notice_lease_until: null })
    expect(notifyUsersOnce).not.toHaveBeenCalled()
  })
})

describe('runShiftOfferSweep', () => {
  it('open offers and claimed ones owed a notice; each processed; counts by outcome', async () => {
    const db = scriptedDb({ shift_offers: [
      { data: [OFFER, { ...OFFER, id: 'o2', broadcast_at: 'x' }], error: null },
      none,
      ok, ok,
    ] })
    const stats = await runShiftOfferSweep(db, { nowMs: IN_BAND })
    expect(stats).toMatchObject({ open: 2, claimed_owed: 0, sent: 1, none: 1, errors: 0, stamp_failed: 0 })
    const [openRead, owedRead] = chainsFor(db, 'shift_offers')
    expect(argsOf(openRead, 'eq')).toEqual(['status', 'open'])
    expect(allArgsOf(owedRead, 'eq')).toEqual([['status', 'claimed']])
    expect(argsOf(owedRead, 'is')).toEqual(['taken_notified_at', null])
    expect(argsOf(owedRead, 'gte')).toEqual(['claimed_at', '2026-09-27T10:00:00.000Z'])
  })
  it('a quiet tick with nothing to send is clean', async () => {
    const db = scriptedDb({ shift_offers: [{ data: [OFFER], error: null }, none] })
    expect(await runShiftOfferSweep(db, { nowMs: QUIET })).toMatchObject({ open: 1, quiet_hours: 1, errors: 0 })
  })
  it('an unreadable list is an error (the heartbeat is not stamped)', async () => {
    const db = scriptedDb({ shift_offers: [{ data: null, error: { message: 'down' } }, none] })
    expect((await runShiftOfferSweep(db, { nowMs: IN_BAND })).errors).toBe(1)
  })
  it('a read that fills its guard is reported as capped, an arm fault', async () => {
    const many = Array.from({ length: SWEEP_LIMIT }, (_, i) => ({ ...OFFER, id: `o${i}`, broadcast_at: 'x' }))
    const db = scriptedDb({ shift_offers: [{ data: many, error: null }, none] })
    const stats = await runShiftOfferSweep(db, { nowMs: IN_BAND })
    expect(stats).toMatchObject({ capped: 1, errors: 1, none: SWEEP_LIMIT })
  })
  it('one offer throwing costs the others nothing', async () => {
    const db = scriptedDb({ shift_offers: [
      { data: [OFFER, { ...OFFER, id: 'o2' }], error: null }, none,
      { data: null, error: { message: 'lease write failed' } }, none,
    ] })
    const stats = await runShiftOfferSweep(db, { nowMs: IN_BAND })
    expect(stats.errors).toBe(1)
    expect(stats.busy).toBe(1)
  })
  it('a lost stamp is counted for the heartbeat', async () => {
    const db = scriptedDb({ shift_offers: [{ data: [OFFER], error: null }, none, ok, { data: null, error: { message: 'x' } }] })
    expect(await runShiftOfferSweep(db, { nowMs: IN_BAND })).toMatchObject({ stamp_failed: 1, errors: 0 })
  })
})

describe('reads and writes', () => {
  it('create inserts location, shift and poster; 23505 = already offered; any other error is an error', async () => {
    const db = scriptedDb({ shift_offers: [{ data: { id: 'o1' }, error: null }, { data: null, error: { code: '23505' } }, { data: null, error: { code: 'XX', message: 'x' } }] })
    expect(await createOffer(db, { block: BLOCK, actorId: 'mgr' })).toEqual({ offer: { id: 'o1' } })
    expect(argsOf(chainsFor(db, 'shift_offers')[0], 'insert')[0]).toEqual({ location_id: 'loc-1', block_id: 'b1', offered_by: 'mgr' })
    expect(await createOffer(db, { block: BLOCK, actorId: 'mgr' })).toEqual({ code: 'already_offered' })
    expect((await createOffer(db, { block: BLOCK, actorId: 'mgr' })).error).toBeTruthy()
  })
  it('withdraw is guarded on still open; zero rows = it changed', async () => {
    const db = scriptedDb({ shift_offers: [ok, none] })
    expect(await withdrawOffer(db, { offerId: 'o1', nowIso: 'T' })).toEqual({ closed: true })
    expect(argsOf(chainsFor(db, 'shift_offers')[0], 'update')[0]).toEqual({ status: 'withdrawn', closed_at: 'T', notice_lease_until: null })
    expect(allArgsOf(chainsFor(db, 'shift_offers')[0], 'eq')).toEqual([['id', 'o1'], ['status', 'open']])
    expect(await withdrawOffer(db, { offerId: 'o1', nowIso: 'T' })).toEqual({ closed: false })
  })
  it('claim calls the RPC by name with its two arguments', async () => {
    const db = scriptedDb({})
    db.rpc.mockResolvedValueOnce({ data: { outcome: 'claimed' }, error: null })
    expect(await claimOffer(db, { offerId: 'o1', profileId: 'c1' })).toEqual({ result: { outcome: 'claimed' }, error: null })
    expect(db.rpc).toHaveBeenCalledWith('claim_shift_offer', { p_offer_id: 'o1', p_profile_id: 'c1' })
  })
  it('a studio\'s list is filtered by its location (the tenant boundary)', async () => {
    const db = scriptedDb({ shift_offers: [{ data: [OFFER], error: null }] })
    expect((await listOpenOffers(db, { locationId: 'loc-1' })).offers).toEqual([OFFER])
    expect(allArgsOf(chainsFor(db, 'shift_offers')[0], 'eq')).toEqual([['location_id', 'loc-1'], ['status', 'open']])
  })
  it('readOffer: 0 rows is null, not an error', async () => {
    const db = scriptedDb({ shift_offers: [{ data: null, error: null }] })
    expect(await readOffer(db, 'o9')).toEqual({ offer: null, error: null })
  })
})

// CLAUDE.md: a column named in a .select() is a claim about the schema, and no
// mock checks it. check:select-columns skips these two (they reach .select()
// through a constant), so this resolves them against the same replay.
describe('the select lists name only real columns (the check:select-columns replay)', () => {
  const { schema } = collectSchema('supabase/migrations')
  const phantoms = (sel, table) => parseSelect(sel, table, schema).filter((r) => !schema.get(r.table)?.has(r.column))

  it('OFFER_SELECT on shift_offers, its block, studio and claimer', () => {
    const refs = parseSelect(OFFER_SELECT, 'shift_offers', schema)
    expect(phantoms(OFFER_SELECT, 'shift_offers')).toEqual([])
    // The replay really descended into the embeds (a floor that read nothing proves nothing).
    for (const [table, column] of [['shift_offers', 'notice_lease_until'], ['shift_blocks', 'min_coaches'], ['shift_templates', 'kind'], ['shift_assignments', 'status'], ['locations', 'timezone'], ['profiles', 'full_name']]) {
      expect(refs).toContainEqual({ table, column })
    }
  })

  it('BLOCK_SELECT on shift_blocks', () => {
    expect(phantoms(BLOCK_SELECT, 'shift_blocks')).toEqual([])
    expect(parseSelect(BLOCK_SELECT, 'shift_blocks', schema)).toContainEqual({ table: 'shift_blocks', column: 'max_coaches' })
  })
})
