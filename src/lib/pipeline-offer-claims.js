// PIPEBUILD.3c — the claims behind OFFER boards (module `offer`).
//
// An offer board's config.entry says how someone gets on it:
//   trial_purchase  a paid/granted trial_purchases row (matched on plan_code,
//                   landing_path or page_id) — the purchase row IS the claim.
//   corp_promo      a granted corp_promo_claims row for one of the promo keys.
//   lead_source     the contact's last_lead_source (lead_source when there is
//                   no last touch) is one of the values.
//   glofox_plan     the contact's glofox_membership_plan contains a value.
//   tag             the contact holds an active contact_tags row for a value.
// The last three are RECORDED once in pipeline_board_claims (board_key = the
// offer board's key, source = the signal) because the contact row moves on
// (Glofox overwrites the plan on every sync, tags are removed): the same
// reasoning as the Programmes claim in pipeline-claims.js.
//
// A claim is { start, end, source, claimedAt }: start/end in epoch ms, and
// claimedAt the ISO time the person started qualifying (PIPEBUILD.5m), which
// is the claim's start: granted_at (else paid_at) of the latest counting
// trial_purchases row, corp_promo_claims.created_at, or
// pipeline_board_claims.claimed_at for the recorded kinds. Every read answers
// { ok: false, reason } on a failure and the whole call fails with it: a
// caller that places people treats that as "cannot tell", never "no claims".
// Only the tables an ACTIVE offer board's entry type uses are read. Logs carry
// ids and bounded errors only.

import { logWarn } from './log.js'
import { selectAll } from './select-all.js'
import { parseOfferConfig } from '../../shared/pipelines/offer-config.js'
import { offerClaimLive } from '../../shared/pipelines/offer.js'
import { paidTrialClaim, DAY_MS } from '../../shared/pipelines/paid-trial.js'
import { OFFER_MODULES } from '../../shared/pipelines/router.js'
import {
  PURCHASE_COLS, toProgrammeClaim, pendingRecordedClaims, upsertBoardClaims,
} from './pipeline-claims.js'

const PAGE = 1000
const ERR_MAX = 200
const bounded = (e) => String(e?.message || e || '').slice(0, ERR_MAX)
const lower = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '')
const parseMs = (v) => {
  if (v == null) return null
  const ms = typeof v === 'number' ? v : Date.parse(v)
  return Number.isFinite(ms) ? ms : null
}

const RECORDED_TYPES = new Set(['lead_source', 'glofox_plan', 'tag'])

/**
 * Enabled offer boards with a parsed config, and the ones skipped because the
 * config would not parse (reported, never thrown).
 * @returns {{ descriptors: Array<{ id, key, priority, config, entry, durationDays }>, skipped: Array<{ key, errors: string[] }> }}
 */
export function splitOfferBoards(boards) {
  const descriptors = []
  const skipped = []
  for (const b of Array.isArray(boards) ? boards : []) {
    if (!b || b.enabled !== true || b.board_type !== 'offer') continue
    const parsed = parseOfferConfig(b.config, { boardKey: b.key, module: b.module })
    if (!parsed.ok) {
      skipped.push({ key: b.key, errors: parsed.errors })
      logWarn('pipeline-offer-claims', 'offer board config skipped', { boardKey: b.key, errors: parsed.errors.slice(0, 5) })
      continue
    }
    descriptors.push({
      id: b.id, key: b.key, priority: b.priority ?? 100,
      config: parsed.config, entry: parsed.config.entry, durationDays: parsed.config.duration_days,
    })
  }
  return { descriptors, skipped }
}

/**
 * PIPEBUILD.3d/3e — locations.membership_source values whose members live in
 * un1t.online (mig 717's legacy 'un1t' included). An offer board reads contacts
 * columns, so it is refused at such a studio (PR 3b brings un1t offer boards).
 */
export const UN1T_MEMBERSHIP_SOURCES = Object.freeze(['un1t_online', 'un1t'])

/**
 * PIPEBUILD.3e — a studio's membership source, for the offer-board refusal on
 * the single-placement paths. Never throws; a failed read or no row is
 * { ok: false } (the caller holds its offer boards, never guesses "contacts").
 * @returns {Promise<{ ok: true, source: string|null } | { ok: false, reason: string }>}
 */
export async function readMembershipSource(db, locationId) {
  try {
    const { data, error } = await db
      .from('locations')
      .select('membership_source')
      .eq('id', locationId)
      .maybeSingle()                       // primary key; 0 rows = no studio
    if (error) {
      logWarn('pipeline-offer-claims', 'membership source unreadable', { locationId, err: bounded(error) })
      return { ok: false, reason: 'membership_source_unreadable' }
    }
    if (!data) {
      logWarn('pipeline-offer-claims', 'membership source unreadable', { locationId, reason: 'no_location_row' })
      return { ok: false, reason: 'membership_source_unreadable' }
    }
    return { ok: true, source: data.membership_source ?? null }
  } catch (e) {
    logWarn('pipeline-offer-claims', 'membership source unreadable', { locationId, err: bounded(e) })
    return { ok: false, reason: 'membership_source_unreadable' }
  }
}

/**
 * PIPEBUILD.3e — the router's board descriptors for a single placement
 * (ensureDealForContact), keyed by pipelines.key like the nightly pass's.
 * Derived, enabled boards only. An offer board carries its parsed config; one
 * that will not parse, one not marked board_type 'offer', and every offer board
 * when its claims are unknown (`offersKnown` false: a refused studio, or a
 * caller that pre-loaded claims without offers) is HELD instead: no descriptor,
 * and its id in `heldIds` so a person with a deal on it is left alone rather
 * than drained off it.
 *
 * PIPEBUILD.5c — an offer board switched on and not yet baselined
 * (`baseline_at` null or absent: mig 815) is held too while `holdUnbaselined`
 * is true, the default every event path uses: its first placements are the
 * nightly pass's, made silently, so switching a board on never messages people
 * who already qualify. Only a caller that places silently may pass false.
 *
 * @param {object[]} boards  pipelines rows
 * @param {{ offersKnown?: boolean, holdUnbaselined?: boolean }} [opts]
 * @returns {{ descriptors: Array<{ key, module, board_type, priority, config }>, heldIds: Set<string> }}
 */
export function placementDescriptors(boards, { offersKnown = true, holdUnbaselined = true } = {}) {
  const descriptors = []
  const heldIds = new Set()
  for (const b of Array.isArray(boards) ? boards : []) {
    if (!b || b.mode !== 'derived' || b.enabled === false || typeof b.key !== 'string') continue
    // PIPEBUILD.3b — an offer_un1t board is placed by the hourly un1t pass
    // only (loadPlacementClaims never loads it): held on every event path, so
    // a person with a deal on it is left alone, as the pass would.
    if (b.module === 'offer_un1t') { heldIds.add(b.id); continue }
    if (OFFER_MODULES.includes(b.module)) {
      const parsed = offersKnown && b.board_type === 'offer' && !(holdUnbaselined && b.baseline_at == null)
        ? splitOfferBoards([{ ...b, enabled: true }]).descriptors[0]
        : null
      if (!parsed) { heldIds.add(b.id); continue }
      descriptors.push({ key: b.key, module: b.module, board_type: 'offer', priority: parsed.priority, config: parsed.config })
      continue
    }
    descriptors.push({ key: b.key, module: b.module, board_type: null, priority: b.priority ?? null, config: null })
  }
  return { descriptors, heldIds }
}

/**
 * PIPEBUILD.3g — the trial_purchase entries ({ match, values }) of the given
 * ENABLED offer boards (board_type 'offer', as splitOfferBoards reads them)
 * whose config parses. Pure and quiet (the loaders log a
 * bad config; this is asked again by the €39 claim loaders).
 * @returns {Array<{ match: string, values: string[] }>}
 */
export function offerPurchaseEntries(boards) {
  return trialPurchaseOfferConfigs(boards).map((d) => d.config.entry)
}

/**
 * PIPEBUILD.3h — the ENABLED trial_purchase offer boards (board_type 'offer')
 * whose config parses, as { key, config }. Pure and quiet, like
 * offerPurchaseEntries.
 * @returns {Array<{ key: string, config: object }>}
 */
export function trialPurchaseOfferConfigs(boards) {
  const out = []
  for (const b of Array.isArray(boards) ? boards : []) {
    if (!b || b.enabled !== true || b.board_type !== 'offer') continue
    const parsed = parseOfferConfig(b.config, { boardKey: b.key, module: b.module })
    if (parsed.ok && parsed.config.entry.type === 'trial_purchase') out.push({ key: b.key, config: parsed.config })
  }
  return out
}

/**
 * PIPEBUILD.3h — a trial_purchase offer board's claim over this contact's
 * purchases: the matching rows, each on the BOARD's duration_days (the same
 * rule as the offer loader). Pure.
 */
export function trialPurchaseOfferClaim(purchases, config, now = Date.now()) {
  const rows = (Array.isArray(purchases) ? purchases : [])
    .filter((p) => purchaseMatchesEntry(p, config.entry))
    .map((p) => ({ ...p, duration_days: config.duration_days }))
  return paidTrialClaim(rows, now)
}

/**
 * PIPEBUILD.3h — is any trial_purchase offer claim in `offers` (a placement's
 * claims.offers, Map<boardKey, claim>) live on its own board's windows? The
 * Class Pack guard: an offer trial's credits are the trial's while its claim
 * is live, whatever the purchase row's own duration says. Pure.
 */
export function liveTrialPurchaseOffer(offers, boards, contact, now = Date.now()) {
  if (!(offers instanceof Map) || offers.size === 0) return false
  for (const { key, config } of trialPurchaseOfferConfigs(boards)) {
    const claim = offers.get(key)
    if (claim && claim.source === 'trial_purchase' && offerClaimLive(claim, contact, now, config)) return true
  }
  return false
}

/**
 * PIPEBUILD.3h — the same test straight from this contact's purchases (the
 * sync path that skips placement and so has no claims.offers). Pure.
 */
export function liveTrialPurchaseOfferFromPurchases(purchases, boards, contact, now = Date.now()) {
  for (const { config } of trialPurchaseOfferConfigs(boards)) {
    const c = trialPurchaseOfferClaim(purchases, config, now)
    if (c && offerClaimLive({ start: c.start, end: c.end }, contact, now, config)) return true
  }
  return false
}

/** Does this trial_purchases row match a trial_purchase entry? Pure. */
export function purchaseMatchesEntry(p, entry) {
  const v = p?.[entry.match]
  return typeof v === 'string' && entry.values.includes(v)
}

/**
 * PIPEBUILD.3g — the purchases that are NOT an offer board's: a purchase an
 * enabled trial_purchase offer board matches is that board's claim, never also
 * a €39 paid claim (else, when the offer claim lapses first, the buyer drops
 * onto the €39 board and its sequences). No entries → the same array.
 */
export function withoutOfferPurchases(purchases, entries) {
  if (!Array.isArray(entries) || entries.length === 0) return purchases
  return (purchases || []).filter((p) => !entries.some((e) => purchaseMatchesEntry(p, e)))
}

const claimOf = (start, durationDays, source) => ({
  start, end: start + durationDays * DAY_MS, source, claimedAt: new Date(start).toISOString(),
})

/**
 * PIPEBUILD.5m — may an EVENT path's first placement onto this offer board fire
 * the board's stage follow-up? Only when the person's claim on the board
 * started at or after the board's `baseline_at`: the nightly pass places every
 * qualifier it reads silently and stamps the baseline, but it reads only the
 * studio's own contacts, so an older claim reaching the board through an event
 * (a sibling-studio contact's webhook, place-now, Cold) must stay silent too.
 * Pure. Answers null (fire) or why the placement is silent:
 *   'no_baseline'            the board carries no readable baseline_at
 *   'claim_time_unknown'     no claim, or no readable claimedAt
 *   'claim_before_baseline'  the claim started before the baseline
 * @param {{ baseline_at?: string|null }} board
 * @param {{ claimedAt?: string }|null} claim
 * @returns {null|'no_baseline'|'claim_time_unknown'|'claim_before_baseline'}
 */
export function offerPlacementSilence(board, claim) {
  const baselineMs = typeof board?.baseline_at === 'string' ? Date.parse(board.baseline_at) : NaN
  if (!Number.isFinite(baselineMs)) return 'no_baseline'
  const claimedMs = typeof claim?.claimedAt === 'string' ? Date.parse(claim.claimedAt) : NaN
  if (!Number.isFinite(claimedMs)) return 'claim_time_unknown'
  return claimedMs >= baselineMs ? null : 'claim_before_baseline'
}

function addOffer(offersByContact, contactId, boardKey, claim) {
  if (!offersByContact.has(contactId)) offersByContact.set(contactId, new Map())
  offersByContact.get(contactId).set(boardKey, claim)
}

const failed = (reason, table, locationId, e) => {
  logWarn('pipeline-offer-claims', `${table} read failed`, { locationId, err: bounded(e) })
  return { ok: false, reason, err: bounded(e) }
}

// Is a stored recorded claim still live on THIS board? The board's own quiet and
// converted windows, over the claim's { start, end } (offerClaimLive's shape).
const boardIsLive = (board) => (stored, contact, now) => offerClaimLive(
  { start: stored.claimedAt, end: stored.claimedAt + board.durationDays * DAY_MS }, contact, now, board.config)

// Who/what a descriptor's signal is, for the three recorded types.
function matcherFor(board, tagAtByContact) {
  const { type, values } = board.entry
  if (type === 'lead_source') {
    return (c, now) => {
      const last = lower(c.last_lead_source)
      const touch = last || (c.last_lead_source == null ? lower(c.lead_source) : '')
      if (!touch || !values.includes(touch)) return null
      // PIPEBUILD.5m — dated by the contact's own times, so a sibling-studio
      // contact's old qualifier is never "new" on its first event. The original
      // lead_source is set when the contact is created: created_at. A last
      // touch is dated by last_lead_source_at, else created_at. `now` only
      // when the row carries neither.
      const createdMs = parseMs(c.created_at)
      const claimedAt = last ? (parseMs(c.last_lead_source_at) ?? createdMs ?? now) : (createdMs ?? now)
      return { claimedAt, source: 'lead_source' }
    }
  }
  if (type === 'glofox_plan') {
    return (c, now) => {
      const plan = lower(c.glofox_membership_plan)
      if (!plan || !values.some((v) => plan.includes(v))) return null
      return { claimedAt: now, source: 'glofox_plan' }
    }
  }
  return (c) => {
    const at = tagAtByContact.get(board.key)?.get(c.id)
    return at == null ? null : { claimedAt: at, source: 'tag' }
  }
}

/**
 * Shared by the studio-wide and the single-contact loader. `scopeContactId`
 * narrows every read to one contact.
 */
async function loadOffers(db, { locationId, boards, contacts, now, scopeContactId = null }) {
  const { descriptors, skipped } = splitOfferBoards(boards)
  const offersByContact = new Map()
  const pending = []
  const people = (contacts || []).filter((c) => c?.id)
  const wanted = new Set(people.map((c) => c.id))
  const used = (t) => descriptors.filter((d) => d.entry.type === t)

  // trial_purchase — one read for every trial board.
  const trialBoards = used('trial_purchase')
  if (trialBoards.length) {
    let rows
    try {
      rows = await selectAll((from, to) => {
        let q = db.from('trial_purchases').select(PURCHASE_COLS).eq('location_id', locationId)
        if (scopeContactId) q = q.eq('contact_id', scopeContactId)
        return q.order('id', { ascending: true }).range(from, to)
      }, { pageSize: PAGE })
    } catch (e) { return failed('purchases_unreadable', 'trial_purchases', locationId, e) }
    for (const board of trialBoards) {
      const byContact = new Map()
      for (const p of rows) {
        if (!p?.contact_id || !wanted.has(p.contact_id)) continue
        if (!byContact.has(p.contact_id)) byContact.set(p.contact_id, [])
        byContact.get(p.contact_id).push(p)
      }
      for (const [contactId, list] of byContact) {
        // PIPEBUILD.3g — the BOARD's duration_days wins over the purchase row's:
        // the builder sets the offer's length, and the row's own (the €39
        // trial's 14 days, a plan default) says nothing about this board.
        const c = trialPurchaseOfferClaim(list, board.config, now)
        // PIPEBUILD.5m — claimedAt is the claim's start: the latest counting
        // purchase's granted_at, else its paid_at (when the trial began).
        if (c) addOffer(offersByContact, contactId, board.key, { start: c.start, end: c.end, source: 'trial_purchase', claimedAt: new Date(c.start).toISOString() })
      }
    }
  }

  // corp_promo — one read for every promo board.
  const promoBoards = used('corp_promo')
  if (promoBoards.length) {
    let rows
    try {
      rows = await selectAll((from, to) => {
        let q = db.from('corp_promo_claims').select('id, contact_id, promo_key, status, created_at')
          .eq('location_id', locationId).eq('status', 'granted')
        if (scopeContactId) q = q.eq('contact_id', scopeContactId)
        return q.order('id', { ascending: true }).range(from, to)
      }, { pageSize: PAGE })
    } catch (e) { return failed('promos_unreadable', 'corp_promo_claims', locationId, e) }
    for (const board of promoBoards) {
      const best = new Map()
      for (const r of rows) {
        if (!r?.contact_id || !wanted.has(r.contact_id) || r.status !== 'granted') continue
        if (!board.entry.values.includes(lower(r.promo_key))) continue
        // PIPEBUILD.3g — the claim starts when the promo was claimed: created_at.
        // updated_at is trigger-maintained, so any later edit would restart it.
        const at = parseMs(r.created_at)
        if (at == null) continue
        if (!best.has(r.contact_id) || at > best.get(r.contact_id)) best.set(r.contact_id, at)
      }
      for (const [contactId, at] of best) addOffer(offersByContact, contactId, board.key, claimOf(at, board.durationDays, 'corp_promo'))
    }
  }

  // lead_source / glofox_plan / tag — recorded once per board.
  const recordedBoards = descriptors.filter((d) => RECORDED_TYPES.has(d.entry.type))
  if (recordedBoards.length) {
    let stored
    try {
      stored = await selectAll((from, to) => {
        let q = db.from('pipeline_board_claims').select('contact_id, board_key, claimed_at, source')
          .eq('location_id', locationId).in('board_key', recordedBoards.map((b) => b.key))
        if (scopeContactId) q = q.eq('contact_id', scopeContactId)
        return q.order('contact_id', { ascending: true }).order('board_key', { ascending: true }).range(from, to)
      }, { pageSize: PAGE })
    } catch (e) { return failed('claims_unreadable', 'pipeline_board_claims', locationId, e) }
    const storedByBoard = new Map()
    for (const r of stored) {
      if (!r?.contact_id || !wanted.has(r.contact_id)) continue
      const claim = toProgrammeClaim(r)
      if (!claim) continue
      if (!storedByBoard.has(r.board_key)) storedByBoard.set(r.board_key, new Map())
      storedByBoard.get(r.board_key).set(r.contact_id, claim)
    }

    const tagBoards = recordedBoards.filter((d) => d.entry.type === 'tag')
    const tagAt = new Map()
    if (tagBoards.length) {
      let tagRows
      try {
        tagRows = await selectAll((from, to) => {
          let q = db.from('contact_tags').select('id, contact_id, tag, added_at')
            .eq('location_id', locationId).is('removed_at', null)
          if (scopeContactId) q = q.eq('contact_id', scopeContactId)
          return q.order('id', { ascending: true }).range(from, to)
        }, { pageSize: PAGE })
      } catch (e) { return failed('tags_unreadable', 'contact_tags', locationId, e) }
      for (const board of tagBoards) {
        const m = new Map()
        for (const t of tagRows) {
          if (!t?.contact_id || !wanted.has(t.contact_id) || !board.entry.values.includes(lower(t.tag))) continue
          const at = parseMs(t.added_at)
          if (at != null && (!m.has(t.contact_id) || at > m.get(t.contact_id))) m.set(t.contact_id, at)
        }
        tagAt.set(board.key, m)
      }
    }

    for (const board of recordedBoards) {
      const have = storedByBoard.get(board.key) || new Map()
      const rows = pendingRecordedClaims(people, have, matcherFor(board, tagAt), board.key, now, boardIsLive(board))
      pending.push(...rows)
      const merged = new Map(have)
      for (const r of rows) merged.set(r.contact_id, { claimedAt: Date.parse(r.claimed_at), source: r.source })
      for (const [contactId, c] of merged) addOffer(offersByContact, contactId, board.key, claimOf(c.claimedAt, board.durationDays, board.entry.type))
    }
  }

  return { ok: true, offersByContact, pending, skipped }
}

/**
 * Every offer claim at a studio, per contact per board. Does not write: the
 * caller records `pending` with upsertBoardClaims.
 *
 * @param {object} db
 * @param {{ locationId: string, boards: object[], contacts: object[], now?: number }} args
 * @returns {Promise<{ ok: true, offersByContact: Map<string, Map<string, {start:number,end:number,source:string,claimedAt:string}>>, pending: object[], skipped: object[] }
 *   | { ok: false, reason: string, err: string }>}
 */
export async function loadOfferClaimsForLocation(db, { locationId, boards, contacts, now = Date.now() }) {
  return loadOffers(db, { locationId, boards, contacts, now })
}

/**
 * One contact's offer claims, for the webhook and place-now paths. Records a
 * pending claim when `write` is true; a failed WRITE still returns the claim
 * (the nightly pass records it again), a failed READ is reported.
 */
export async function loadOfferClaimsForContact(db, { locationId, boards, contact, now = Date.now(), write = true }) {
  if (!contact?.id) return { ok: true, offers: new Map(), skipped: [] }
  const res = await loadOffers(db, { locationId, boards, contacts: [contact], now, scopeContactId: contact.id })
  if (!res.ok) return res
  if (write && res.pending.length > 0) await upsertBoardClaims(db, locationId, res.pending, now)
  return { ok: true, offers: res.offersByContact.get(contact.id) || new Map(), skipped: res.skipped }
}

// ---------------------------------------------------------------------------
// PIPEBUILD.3b — claims for `offer_un1t` boards (a un1t.online studio).

/**
 * A un1t_product board's claim from one person's un1t_transactions rows. Pure.
 * Rows whose product_id is exactly one of entry.values (case kept), not
 * refunded, with a readable remote_created_at; the newest wins. Amount is never
 * read: a EUR 0 purchase of the product is still the offer.
 * @returns {{ start: number, end: number } | null}
 */
export function un1tProductOfferClaim(transactions, config, now = Date.now()) { // eslint-disable-line no-unused-vars
  const values = config?.entry?.values || []
  let best = null
  for (const t of Array.isArray(transactions) ? transactions : []) {
    if (!t || t.refunded === true || !values.includes(t.product_id)) continue
    const at = parseMs(t.remote_created_at)
    if (at != null && (best == null || at > best)) best = at
  }
  return best == null ? null : { start: best, end: best + config.duration_days * DAY_MS }
}

const IN_CHUNK = 200

/**
 * Offer claims for the offer_un1t boards at one un1t.online studio, per contact
 * per board key. Only enabled board_type 'offer' boards of module offer_un1t
 * with a parseable config count (the rest are `skipped`). trial_purchase and
 * corp_promo boards go through loadOffers (same reads, same rules); un1t_product
 * boards read un1t_transactions. A failed read fails the call (never "no claims").
 * @returns {Promise<{ ok: true, offersByContact: Map, skipped: object[] } | { ok: false, reason: string, err: string }>}
 */
export async function loadUn1tOfferClaims(db, { locationId, boards, contactIds, now = Date.now() }) {
  const skipped = []
  const eligible = []
  const productBoards = []
  for (const b of Array.isArray(boards) ? boards : []) {
    if (!b || b.enabled !== true || b.board_type !== 'offer' || b.module !== 'offer_un1t') continue
    const parsed = parseOfferConfig(b.config, { boardKey: b.key, module: 'offer_un1t' })
    if (!parsed.ok) {
      skipped.push({ key: b.key, errors: parsed.errors })
      logWarn('pipeline-offer-claims', 'offer board config skipped', { boardKey: b.key, errors: parsed.errors.slice(0, 5) })
      continue
    }
    if (parsed.config.entry.type === 'un1t_product') {
      productBoards.push({ key: b.key, config: parsed.config })
    } else eligible.push(b)
  }
  // Boards that were skipped by the module/enabled filter are reported too, as
  // splitOfferBoards does for a bad config only: here a wrong-module board is
  // simply not ours, but is listed so a caller can see it was not read.
  for (const b of Array.isArray(boards) ? boards : []) {
    if (b && b.board_type === 'offer' && (b.enabled !== true || b.module !== 'offer_un1t')) {
      skipped.push({ key: b.key, errors: [b.enabled !== true ? 'disabled' : 'not an offer_un1t board'] })
    }
  }

  const offersByContact = new Map()
  const wanted = new Set(contactIds || [])

  if (eligible.length) {
    const res = await loadOffers(db, {
      locationId, boards: eligible, contacts: (contactIds || []).map((id) => ({ id })), now,
    })
    if (!res.ok) return res
    for (const [cid, m] of res.offersByContact) for (const [k, claim] of m) addOffer(offersByContact, cid, k, claim)
  }

  if (productBoards.length) {
    const productIds = [...new Set(productBoards.flatMap((b) => b.config.entry.values))]
    const rows = []
    try {
      for (let i = 0; i < productIds.length; i += IN_CHUNK) {
        const chunk = productIds.slice(i, i + IN_CHUNK)
        const part = await selectAll((from, to) => db
          .from('un1t_transactions')
          .select('un1t_id, un1t_user_id, contact_id, product_id, refunded, remote_created_at')
          .eq('location_id', locationId)
          .in('product_id', chunk)
          .order('un1t_id', { ascending: true })
          .range(from, to), { pageSize: PAGE })
        rows.push(...part)
      }
    } catch (e) { return failed('un1t_transactions_unreadable', 'un1t_transactions', locationId, e) }

    let clients
    try {
      clients = await selectAll((from, to) => db
        .from('un1t_clients')
        .select('un1t_user_id, contact_id')
        .eq('location_id', locationId)
        .order('id', { ascending: true })
        .range(from, to), { pageSize: PAGE })
    } catch (e) { return failed('un1t_clients_unreadable', 'un1t_clients', locationId, e) }

    // Ownership mirrors src/lib/membership/reads/un1t-online.js (its helpers are
    // private): a row's person is its un1t user's contact, else its own contact_id.
    const contactOfUser = new Map(clients.filter((c) => c?.contact_id != null).map((c) => [c.un1t_user_id, c.contact_id]))
    const owner = (r) => (r.un1t_user_id != null ? contactOfUser.get(r.un1t_user_id) : null) ?? r.contact_id ?? null
    const byContact = new Map()
    for (const r of rows) {
      const o = owner(r)
      if (!o || !wanted.has(o)) continue
      if (!byContact.has(o)) byContact.set(o, [])
      byContact.get(o).push(r)
    }
    for (const board of productBoards) {
      for (const [contactId, list] of byContact) {
        const c = un1tProductOfferClaim(list, board.config, now)
        if (c) addOffer(offersByContact, contactId, board.key, claimOf(c.start, board.config.duration_days, 'un1t_product'))
      }
    }
  }

  return { ok: true, offersByContact, skipped }
}
