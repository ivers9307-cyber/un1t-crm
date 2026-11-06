// PIPE3.7 — place one contact on the studio's boards right now (after a trial
// grant, after a /50plus lead lands), through ensureDealForContact.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./glofox-sync.js', () => ({ ensureDealForContact: vi.fn() }))
vi.mock('./log.js', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('./sequences/triggers.js', () => ({ triggerSequencesForDealPlacement: vi.fn(async () => {}) }))

import { ensureDealForContact } from './glofox-sync.js'
import { triggerSequencesForDealPlacement } from './sequences/triggers.js'
import { allRequiredFields } from '../../shared/pipelines/index.js'
import { requiredFields as offerFields } from '../../shared/pipelines/offer.js'
import { placeContactNow, PLACE_NOW_COLUMNS } from './pipeline-place-now.js'

const LOC = 'loc-st'
const contactRow = { id: 'c1', name: 'Ava', location_id: LOC, glofox_membership_status: 'trial', last_lead_source: 'meta_trial' }
const dbWith = ({ row = contactRow, error = null } = {}) => {
  const calls = []
  const q = {
    select: (cols) => { calls.push(['select', cols]); return q },
    eq: (col, val) => { calls.push(['eq', col, val]); return q },
    maybeSingle: async () => ({ data: error ? null : row, error }),
  }
  return { db: { from: (t) => { calls.push(['from', t]); return q } }, calls }
}

beforeEach(() => {
  vi.mocked(ensureDealForContact).mockReset(); vi.mocked(ensureDealForContact).mockResolvedValue({ action: 'move' })
  vi.mocked(triggerSequencesForDealPlacement).mockReset(); vi.mocked(triggerSequencesForDealPlacement).mockResolvedValue(undefined)
})

describe('placeContactNow', () => {
  it('reads the contact by id with the placement columns and places it at the studio', async () => {
    const { db, calls } = dbWith()
    const out = await placeContactNow(db, { locationId: LOC, contactId: 'c1', now: 123 })
    expect(out).toEqual({ ok: true, deal: { action: 'move' } })
    expect(calls[0]).toEqual(['from', 'contacts'])
    expect(calls[1][1]).toBe(PLACE_NOW_COLUMNS)
    expect(calls[2]).toEqual(['eq', 'id', 'c1'])
    expect(ensureDealForContact).toHaveBeenCalledWith(db, LOC, 'c1', contactRow, 'Ava', { now: 123 })
  })
  it('the column list carries what the router reads', () => {
    for (const col of ['location_id', 'lead_source', 'last_lead_source', 'glofox_membership_plan', 'last_payment_at', 'pipeline_dismissed_at', 'gympass_member_id', 'recent_bookings']) {
      expect(PLACE_NOW_COLUMNS.split(', ')).toContain(col)
    }
  })
  it('a contact read error is reported, never thrown; a missing contact too', async () => {
    expect(await placeContactNow(dbWith({ error: { message: 'x' } }).db, { locationId: LOC, contactId: 'c1' })).toEqual({ ok: false, reason: 'contact_unreadable' })
    expect(await placeContactNow(dbWith({ row: null }).db, { locationId: LOC, contactId: 'c1' })).toEqual({ ok: false, reason: 'contact_missing' })
    expect(ensureDealForContact).not.toHaveBeenCalled()
  })
  it('a throwing placement is reported, never thrown', async () => {
    vi.mocked(ensureDealForContact).mockRejectedValue(new Error('boom'))
    expect(await placeContactNow(dbWith().db, { locationId: LOC, contactId: 'c1' })).toEqual({ ok: false, reason: 'placement_threw' })
  })
  it('missing arguments are refused without a read', async () => {
    const { db, calls } = dbWith()
    expect(await placeContactNow(db, { locationId: null, contactId: 'c1' })).toEqual({ ok: false, reason: 'missing_arguments' })
    expect(calls).toHaveLength(0)
  })
  it('placeNowColumnsCoverOffer: every registered board module\'s fields, the offer board\'s included, plus location_id', () => {
    const cols = PLACE_NOW_COLUMNS.split(', ')
    for (const col of [...offerFields, 'last_lead_source_at', 'location_id']) expect(cols).toContain(col)
    for (const col of allRequiredFields()) expect(cols).toContain(col)
    expect(new Set(cols).size).toBe(cols.length)
  })
  // PIPEBUILD.3e — the result goes through the sequence adapter, configured
  // boards only: an offer board's stage starts its follow-up; the boards that
  // fired nothing from place-now before still fire nothing.
  it('passes the placement through the stage trigger, configured boards only, at the studio', async () => {
    const placed = { action: 'create', deal_id: 'd1', stage_slug: 'corp_new', pipeline_id: 'p-corp' }
    vi.mocked(ensureDealForContact).mockResolvedValue(placed)
    const out = await placeContactNow(dbWith().db, { locationId: LOC, contactId: 'c1', now: 1 })
    expect(out).toEqual({ ok: true, deal: placed })
    expect(triggerSequencesForDealPlacement).toHaveBeenCalledWith('c1', placed, { dealLocationId: LOC, pipelineId: 'p-corp', configuredBoardsOnly: true })
  })
  it('a move names its own studio; an error or leave result fires nothing', async () => {
    const moved = { action: 'move', deal_id: 'd1', from_slug: 'new_lead', to_slug: 'corp_new', pipeline_id: 'p-corp', location_id: LOC }
    vi.mocked(ensureDealForContact).mockResolvedValueOnce(moved)
    await placeContactNow(dbWith().db, { locationId: LOC, contactId: 'c1' })
    expect(triggerSequencesForDealPlacement).toHaveBeenCalledWith('c1', moved, { dealLocationId: LOC, pipelineId: 'p-corp', configuredBoardsOnly: true })
    vi.mocked(triggerSequencesForDealPlacement).mockClear()
    vi.mocked(ensureDealForContact).mockResolvedValueOnce({ action: 'error', error: 'x' })
    await placeContactNow(dbWith().db, { locationId: LOC, contactId: 'c1' })
    expect(triggerSequencesForDealPlacement).not.toHaveBeenCalled()
  })
  it('a throwing trigger never fails the placement', async () => {
    vi.mocked(ensureDealForContact).mockResolvedValue({ action: 'create', deal_id: 'd1', stage_slug: 'corp_new', pipeline_id: 'p-corp' })
    vi.mocked(triggerSequencesForDealPlacement).mockRejectedValue(new Error('sequences down'))
    expect(await placeContactNow(dbWith().db, { locationId: LOC, contactId: 'c1' })).toMatchObject({ ok: true, deal: { action: 'create' } })
  })
})
