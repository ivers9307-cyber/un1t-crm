// PIPE3.5 — the claims behind the board router (shared/pipelines/router.js).
// Spec: docs/superpowers/specs/2026-10-31-stillorgan-three-pipelines-design.md
//
// Two claims decide whether a person leaves the acquisition board:
//   • the PAID claim — a trial_purchases row the person paid for (the €39
//     14-day trial). Never duplicated: the purchase row IS the claim.
//   • the PROGRAMME claim — a pipeline_board_claims row (mig 797), recorded the
//     first time a contact matches the studio's programme rules
//     (locations.settings.pipelines.programmes: landing-page lead sources and
//     Glofox trial plan names). Recorded, not re-derived, because Glofox
//     overwrites glofox_membership_plan on every sync and a lead who joins
//     would stop matching at the moment they should enter Converted.
//
// Every read here answers { ok: false, reason } on a failure. A caller that
// places people (the nightly pass, the webhook path) treats that as "cannot
// tell" and places NOBODY this time — never as "no claims", which would move
// every €39 buyer back to the acquisition board. Logs carry ids only.

import { logWarn } from './log.js'
import { selectAll } from './select-all.js'
import { paidTrialClaim, claimLive as paidClaimLive } from '../../shared/pipelines/paid-trial.js'
import { matchProgrammeSignal, programmeClaimLive } from '../../shared/pipelines/programmes.js'
import { BOARD_KEYS, CLAIM_BOARD_MODULES, OFFER_MODULES } from '../../shared/pipelines/router.js'
import {
  loadOfferClaimsForContact, readMembershipSource, UN1T_MEMBERSHIP_SOURCES,
  offerPurchaseEntries, withoutOfferPurchases, liveTrialPurchaseOffer, liveTrialPurchaseOfferFromPurchases,
} from './pipeline-offer-claims.js'

export const PROGRAMME_RULES_PATH = Object.freeze(['pipelines', 'programmes'])
const PROGRAMME_BOARD = BOARD_KEYS.PROGRAMMES
const UPSERT_CHUNK = 500
const PAGE = 1000
const ERR_MAX = 200
const bounded = (e) => String(e?.message || e || '').slice(0, ERR_MAX)
const EMPTY_RULES = Object.freeze({ lead_sources: Object.freeze([]), glofox_plan_patterns: Object.freeze([]) })

const cleanList = (v) => (Array.isArray(v)
  ? v.filter((x) => typeof x === 'string').map((x) => x.trim().toLowerCase()).filter(Boolean)
  : [])

/**
 * The programme rules held in a location's settings jsonb.
 * @param {object|null} settings  locations.settings
 * @returns {{ lead_sources: string[], glofox_plan_patterns: string[] }}
 */
export function programmeRulesFromSettings(settings) {
  const slice = settings?.pipelines?.programmes
  if (!slice || typeof slice !== 'object' || Array.isArray(slice)) return { lead_sources: [], glofox_plan_patterns: [] }
  return { lead_sources: cleanList(slice.lead_sources), glofox_plan_patterns: cleanList(slice.glofox_plan_patterns) }
}

/**
 * A location's ENABLED boards. PIPEBUILD.5c — with baseline_at (mig 815): an
 * offer board not yet baselined is held on the event paths
 * (placementDescriptors), so every caller handing these rows on must read it.
 *
 * PIPEBUILD.5o — the same one read also names the location's SWITCHED-OFF
 * offer boards (`board_type` set, `enabled` false) as `disabledOfferIds`,
 * present only when there is one. A person with an open deal on one is left
 * exactly where they are on every placement path (ensureDealForContact, the
 * nightly pass), like a person on a held board: switching an offer board off
 * to edit it must not hand its people to another board and its follow-ups.
 * Built-in boards (`board_type` null) never count, so a studio without a
 * switched-off offer board gets exactly today's answer. The filter is in
 * memory, so the boards and the holds come from one read and fail together.
 */
export async function loadBoardsForLocation(db, locationId) {
  const { data, error } = await db
    .from('pipelines')
    .select('id, key, module, mode, enabled, is_primary, board_type, config, priority, baseline_at')
    .eq('location_id', locationId)
  if (error) {
    logWarn('pipeline-claims', 'pipelines read failed', { locationId, err: bounded(error) })
    return { ok: false, reason: 'boards_unreadable', err: bounded(error) }
  }
  const rows = Array.isArray(data) ? data : []
  const disabledOfferIds = disabledOfferBoardIds(rows)
  return {
    ok: true,
    boards: rows.filter((b) => b && b.enabled !== false),
    ...(disabledOfferIds.length > 0 ? { disabledOfferIds } : {}),
  }
}

/** PIPEBUILD.5o — the ids of switched-off offer boards among `rows`. Pure. */
export function disabledOfferBoardIds(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((b) => b && b.enabled === false && b.board_type != null && b.id)
    .map((b) => b.id)
}

/** The programme rules for a location, from locations.settings. */
export async function loadProgrammeRules(db, locationId) {
  const { data, error } = await db
    .from('locations')
    .select('settings')
    .eq('id', locationId)
    .maybeSingle()                         // primary key; 0 rows = no settings
  if (error) {
    logWarn('pipeline-claims', 'settings read failed', { locationId, err: bounded(error) })
    return { ok: false, reason: 'settings_unreadable', err: bounded(error) }
  }
  return { ok: true, rules: programmeRulesFromSettings(data?.settings) }
}

export const PURCHASE_COLS = 'id, contact_id, status, payment_status, paid_at, granted_at, duration_days, plan_code, landing_path, page_id'
const CLAIM_COLS = 'contact_id, claimed_at, source'

export const toProgrammeClaim = (row) => {
  const ms = Date.parse(row?.claimed_at)
  return Number.isFinite(ms) ? { claimedAt: ms, source: row.source ?? null } : null
}

/**
 * Every claim at a location, keyed by contact id, limited to `contactIds`
 * (the run's contact set: a Hatch-home buyer of the Stillorgan trial is not
 * in it, and is placed only as today — spec, Routing).
 *
 * PIPEBUILD.3g — `offerBoards` (the run's enabled offer boards) takes a
 * purchase a trial_purchase offer board matches out of the €39 paid claim: it
 * is that board's claim. The same rows already read, filtered in memory, so a
 * studio with no trial_purchase offer board computes exactly today's claims.
 *
 * @returns {Promise<{ ok: true, paidByContact: Map, programmeByContact: Map }
 *   | { ok: false, reason: 'purchases_unreadable'|'claims_unreadable', err: string }>}
 */
export async function loadClaimsForLocation(db, { locationId, contactIds, now = Date.now(), offerBoards = null }) {
  const wanted = contactIds instanceof Set ? contactIds : new Set(contactIds || [])
  const offerEntries = offerPurchaseEntries(offerBoards)

  let purchases
  try {
    purchases = await selectAll((from, to) => db
      .from('trial_purchases')
      .select(PURCHASE_COLS)
      .eq('location_id', locationId)
      .order('id', { ascending: true })
      .range(from, to), { pageSize: PAGE })
  } catch (e) {
    logWarn('pipeline-claims', 'trial_purchases read failed', { locationId, err: bounded(e) })
    return { ok: false, reason: 'purchases_unreadable', err: bounded(e) }
  }

  let claimRows
  try {
    claimRows = await selectAll((from, to) => db
      .from('pipeline_board_claims')
      .select(CLAIM_COLS)
      .eq('location_id', locationId)
      .eq('board_key', PROGRAMME_BOARD)
      .order('contact_id', { ascending: true })
      .range(from, to), { pageSize: PAGE })
  } catch (e) {
    logWarn('pipeline-claims', 'pipeline_board_claims read failed', { locationId, err: bounded(e) })
    return { ok: false, reason: 'claims_unreadable', err: bounded(e) }
  }

  const byContact = new Map()
  for (const p of withoutOfferPurchases(purchases, offerEntries)) {
    if (!p?.contact_id || !wanted.has(p.contact_id)) continue
    if (!byContact.has(p.contact_id)) byContact.set(p.contact_id, [])
    byContact.get(p.contact_id).push(p)
  }
  const paidByContact = new Map()
  for (const [contactId, rows] of byContact) {
    const claim = paidTrialClaim(rows, now)
    if (claim) paidByContact.set(contactId, claim)
  }

  const programmeByContact = new Map()
  for (const r of claimRows) {
    if (!r?.contact_id || !wanted.has(r.contact_id)) continue
    const claim = toProgrammeClaim(r)
    if (claim) programmeByContact.set(r.contact_id, claim)
  }
  return { ok: true, paidByContact, programmeByContact }
}

/**
 * The claims to record for ONE board, whatever its way in. `matcher(contact,
 * now)` answers `{ claimedAt, source }` or null. A contact with no stored claim
 * who matches gets a row; a LAPSED stored claim is renewed by a newer
 * lead-source touch ("a second /50plus signup after the claim went quiet");
 * a LIVE claim is never reset; a plan or tag match never renews (it carries no
 * touch date of its own). `isLive(stored, contact, now)` defaults to the
 * programme rule. Pure.
 *
 * @returns {Array<{ contact_id: string, board_key: string, claimed_at: string, source: string }>}
 */
export function pendingRecordedClaims(contacts, storedByContact, matcher, boardKey, now = Date.now(), isLive = programmeClaimLive) {
  const out = []
  const stored = storedByContact instanceof Map ? storedByContact : new Map()
  for (const c of contacts || []) {
    if (!c?.id) continue
    const signal = matcher(c, now)
    if (!signal) continue
    const existing = stored.get(c.id)
    if (existing) {
      if (signal.source !== 'lead_source') continue
      if (!(signal.claimedAt > existing.claimedAt)) continue
      if (isLive(existing, c, now)) continue
    }
    out.push({ contact_id: c.id, board_key: boardKey, claimed_at: new Date(signal.claimedAt).toISOString(), source: signal.source })
  }
  return out
}

/** The programme claims to record: pendingRecordedClaims with the programme matcher. Pure. */
export function pendingProgrammeClaims(contacts, programmeByContact, rules, now = Date.now()) {
  return pendingRecordedClaims(contacts, programmeByContact, (c, n) => matchProgrammeSignal(c, rules, n), PROGRAMME_BOARD, now)
}

/** Record claims for any board (upsert on the PK). Never throws. */
export async function upsertBoardClaims(db, locationId, rows, now = Date.now()) {
  if (!Array.isArray(rows) || rows.length === 0) return { ok: true, written: 0 }
  const stamp = new Date(now).toISOString()
  let written = 0
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK).map((r) => ({
      contact_id: r.contact_id,
      location_id: locationId,
      board_key: r.board_key || PROGRAMME_BOARD,
      claimed_at: r.claimed_at,
      source: r.source,
      updated_at: stamp,
    }))
    try {
      const { error } = await db
        .from('pipeline_board_claims')
        .upsert(chunk, { onConflict: 'contact_id,location_id,board_key' })
      if (error) {
        logWarn('pipeline-claims', 'claims upsert failed', { locationId, err: bounded(error), chunk_start: i })
        return { ok: false, written, error: bounded(error) }
      }
    } catch (e) {
      logWarn('pipeline-claims', 'claims upsert threw', { locationId, err: bounded(e), chunk_start: i })
      return { ok: false, written, error: bounded(e) }
    }
    written += chunk.length
  }
  return { ok: true, written }
}

export const upsertProgrammeClaims = upsertBoardClaims

/**
 * One contact's claims, for the webhook and Cold paths. Records a pending
 * programme claim when `write` is true; a failed WRITE still returns the claim
 * (the nightly pass records it again), a failed READ is reported.
 *
 * PIPEBUILD.3g — `offerBoards` as in loadClaimsForLocation: a purchase a
 * trial_purchase offer board matches is not a €39 paid claim. When one is
 * given, `purchasePaid` carries the claim over EVERY purchase, for the Class
 * Pack guard (an offer trial's credits are the trial's, never a pack). With no
 * such board the result is exactly today's shape.
 *
 * @returns {Promise<{ ok: true, claims: { paid: object|null, programme: { claimedAt:number, source:string|null }|null }, purchasePaid?: object|null }
 *   | { ok: false, reason: string, err?: string }>}
 */
export async function loadClaimsForContact(db, { locationId, contactId, contact, now = Date.now(), rules = EMPTY_RULES, write = true, offerBoards = null }) {
  const { data: purchases, error: pErr } = await db
    .from('trial_purchases')
    .select(PURCHASE_COLS)
    .eq('location_id', locationId)
    .eq('contact_id', contactId)
  if (pErr) {
    logWarn('pipeline-claims', 'trial_purchases read failed', { locationId, contactId, err: bounded(pErr) })
    return { ok: false, reason: 'purchases_unreadable', err: bounded(pErr) }
  }
  const { data: claimRows, error: cErr } = await db
    .from('pipeline_board_claims')
    .select(CLAIM_COLS)
    .eq('location_id', locationId)
    .eq('contact_id', contactId)
    .eq('board_key', PROGRAMME_BOARD)
  if (cErr) {
    logWarn('pipeline-claims', 'pipeline_board_claims read failed', { locationId, contactId, err: bounded(cErr) })
    return { ok: false, reason: 'claims_unreadable', err: bounded(cErr) }
  }

  const allPurchases = Array.isArray(purchases) ? purchases : []
  const offerEntries = offerPurchaseEntries(offerBoards)
  const purchasePaid = paidTrialClaim(allPurchases, now)
  const paid = offerEntries.length > 0 ? paidTrialClaim(withoutOfferPurchases(allPurchases, offerEntries), now) : purchasePaid
  const stored = Array.isArray(claimRows) && claimRows[0] ? toProgrammeClaim(claimRows[0]) : null
  const storedMap = new Map(stored ? [[contactId, stored]] : [])
  const pending = pendingProgrammeClaims([{ ...(contact || {}), id: contactId }], storedMap, rules, now)
  let programme = stored
  if (pending.length > 0) {
    programme = { claimedAt: Date.parse(pending[0].claimed_at), source: pending[0].source }
    if (write) await upsertProgrammeClaims(db, locationId, pending, now)
  }
  return { ok: true, claims: { paid, programme }, ...(offerEntries.length > 0 ? { purchasePaid } : {}) }
}

/**
 * PIPE3.7 — everything a single placement (webhook, Cold, place-now) needs in
 * one call: the studio's enabled boards, and, when one of them is a claim
 * board, this contact's claims (recording a new programme match). A studio
 * with no claim board answers { claimBoards: false, claims: null } after the
 * one boards read and nothing else.
 *
 * PIPEBUILD.3e — an offer board is a claim board too. Its claims ride along as
 * `claims.offers` (Map<boardKey, claim>, recording a new lead-source / plan /
 * tag match), and the €39/Programmes tables are read only when one of THOSE
 * boards runs. At a un1t.online studio, or when its membership source cannot
 * be read, the offer boards are refused: `claims.offers` is null and
 * `offersRefused` says why (ensureDealForContact then holds them). A studio
 * with no offer board gets exactly today's claims shape (no `offers` key).
 * A failed offer READ fails the call; a recorded claim already written by then
 * is a fact the nightly pass would record the same way.
 *
 * PIPEBUILD.3h — an unreadable membership source beside a trial_purchase
 * offer board fails the call (membership_source_unreadable: places nobody,
 * no pack stamp). Whenever a trial_purchase offer board runs, the claim over
 * every purchase reaches placementPackGuard: as `purchasePaid`, at a studio
 * with no €39/Programmes board too, or as claims.paid itself when a €39 board
 * runs beside refused offer boards (which take nothing out of it).
 *
 * @returns {Promise<{ ok: true, boards: object[], claimBoards: boolean, claims: { paid, programme, offers? }|null, offersRefused?: string, purchasePaid?: object|null, disabledOfferIds?: string[] }
 *   | { ok: false, reason: string, boards?: object[] }>}
 */
export async function loadPlacementClaims(db, { locationId, contactId, contact, now = Date.now(), write = true }) {
  const boardsRes = await loadBoardsForLocation(db, locationId)
  if (!boardsRes.ok) return { ok: false, reason: boardsRes.reason }
  const boards = boardsRes.boards
  // PIPEBUILD.5o — the switched-off offer boards ride along on every answer
  // (only when there is one), so ensureDealForContact holds their people.
  const holds = boardsRes.disabledOfferIds ? { disabledOfferIds: boardsRes.disabledOfferIds } : {}
  const derived = boards.filter((b) => b.mode === 'derived')
  const legacyBoards = derived.some((b) => CLAIM_BOARD_MODULES.includes(b.module))
  // PIPEBUILD.3b — `offer` boards only: an `offer_un1t` board is placed by the
  // hourly un1t pass alone (no event path places at a un1t.online studio, and
  // anywhere else the pass refuses it), so it is never loaded here and
  // placementDescriptors holds it. offersRefused therefore only ever names
  // `offer` boards a un1t.online studio refuses.
  const enabledOfferRows = derived.filter((b) => OFFER_MODULES.includes(b.module) && b.module !== 'offer_un1t')
  // AUDIT.2 — only a BASELINED offer board loads claims and takes purchases
  // out of the €39 claim here. placementDescriptors holds an unbaselined one
  // on every event path (PIPEBUILD.5c), so stripping for it left a current
  // €39 buyer with no paid claim and no board to go to: on the next webhook
  // they read as a Class Pack member and their deal left the €39 board until
  // the nightly pass. The nightly strips for every enabled offer board because
  // it places them (silently). The membership-source read below still keys on
  // every enabled offer board, so a refusal is answered exactly as before.
  const offerRows = enabledOfferRows.filter((b) => b.baseline_at != null)
  if (!legacyBoards && offerRows.length === 0) return { ok: true, boards, claimBoards: false, claims: null, ...holds }

  // The membership source is read first (only when an offer board runs), so a
  // refused studio's offer boards take nothing out of the €39 claim, exactly
  // as on the nightly pass, which drops refused boards before reading claims.
  // PIPEBUILD.3h — an UNREADABLE source beside a trial_purchase offer board
  // is "cannot tell" for the claims too: whether the purchase is the offer's
  // or the €39 claim hangs on it, and keeping it as €39 could put an offer
  // buyer on the €39 board and its follow-ups. So it places nobody this time
  // (and no pack stamp). A un1t.online studio is a deliberate answer, not an
  // unknown, and is unchanged; so is an unreadable source whose offer boards
  // hold no trial purchase (they are held, the other boards run).
  const offerTrialEntries = offerPurchaseEntries(offerRows)
  let offersRefused = null
  if (enabledOfferRows.length > 0) {
    const source = await readMembershipSource(db, locationId)
    if (!source.ok && offerTrialEntries.length > 0) {
      logWarn('pipeline-claims', 'membership source unreadable beside a trial_purchase offer board; placing nobody', { locationId })
      return { ok: false, reason: source.reason, boards }
    }
    offersRefused = !source.ok
      ? source.reason
      : (UN1T_MEMBERSHIP_SOURCES.includes(source.source) ? 'un1t_online_studio' : null)
  }

  let claims = { paid: null, programme: null }
  let purchasePaid
  if (legacyBoards) {
    const rulesRes = await loadProgrammeRules(db, locationId)
    if (!rulesRes.ok) return { ok: false, reason: rulesRes.reason, boards }
    const claimsRes = await loadClaimsForContact(db, {
      locationId, contactId, contact, now, rules: rulesRes.rules, write,
      offerBoards: offersRefused ? null : offerRows,
    })
    if (!claimsRes.ok) return { ok: false, reason: claimsRes.reason, boards }
    claims = claimsRes.claims
    if ('purchasePaid' in claimsRes) purchasePaid = claimsRes.purchasePaid
  } else if (offerTrialEntries.length > 0) {
    // PIPEBUILD.3h — no €39/Programmes board, but a trial_purchase offer
    // board: the Class Pack guard still needs the claim over every purchase
    // (else an offer trial's credits could stamp a pack here while the
    // skip-placement path guards them). One indexed read.
    const paidRes = await loadPaidClaimForContact(db, { locationId, contactId, now })
    if (!paidRes.ok) return { ok: false, reason: paidRes.reason, boards }
    purchasePaid = paidRes.claim
  }
  // PIPEBUILD.3g — the paid claim over every purchase, present only when an
  // offer board took a purchase out of `claims.paid` (the Class Pack guard).
  const extra = purchasePaid !== undefined ? { purchasePaid } : {}
  if (offerRows.length === 0) return { ok: true, boards, claimBoards: true, claims, ...extra, ...holds }

  if (offersRefused) {
    logWarn('pipeline-claims', 'offer boards refused', { locationId, reason: offersRefused })
    return { ok: true, boards, claimBoards: true, claims: { ...claims, offers: null }, offersRefused, ...extra, ...holds }
  }
  const offerRes = await loadOfferClaimsForContact(db, {
    locationId, boards: offerRows, contact: { ...(contact || {}), id: contactId }, now, write,
  })
  if (!offerRes.ok) return { ok: false, reason: offerRes.reason, boards }
  return { ok: true, boards, claimBoards: true, claims: { ...claims, offers: offerRes.offers }, ...extra, ...holds }
}

async function readContactPurchases(db, { locationId, contactId }) {
  const { data, error } = await db
    .from('trial_purchases')
    .select(PURCHASE_COLS)
    .eq('location_id', locationId)
    .eq('contact_id', contactId)
  if (error) {
    logWarn('pipeline-claims', 'trial_purchases read failed', { locationId, contactId, err: bounded(error) })
    return { ok: false, reason: 'purchases_unreadable', err: bounded(error) }
  }
  return { ok: true, purchases: Array.isArray(data) ? data : [] }
}

/**
 * PIPE3 fix pass — this contact's PAID claim alone, one indexed read: the
 * claim over EVERY purchase. Independent of the studio's boards: the purchase
 * row is the fact.
 * @returns {Promise<{ ok: true, claim: object|null } | { ok: false, reason: 'purchases_unreadable', err: string }>}
 */
export async function loadPaidClaimForContact(db, { locationId, contactId, now = Date.now() }) {
  const res = await readContactPurchases(db, { locationId, contactId })
  if (!res.ok) return res
  return { ok: true, claim: paidTrialClaim(res.purchases, now) }
}

/**
 * PIPEBUILD.3h — the Class Pack guard from a placement's claims (the sync path
 * that places): live when the €39 claim over every purchase is live
 * (`purchasePaid` when an offer board took a purchase out of claims.paid,
 * else claims.paid), OR any trial_purchase offer claim in claims.offers is
 * live on its own board's windows (an offer of 21 days outlives the row's 14).
 * A studio with no offer board: exactly the old `claimLive(claims.paid)`. Pure.
 */
export function placementPackGuard(placement, contact, now = Date.now()) {
  const paidClaim = placement && 'purchasePaid' in placement ? placement.purchasePaid : (placement?.claims?.paid ?? null)
  if (paidClaimLive(paidClaim, contact, now)) return true
  return liveTrialPurchaseOffer(placement?.claims?.offers, offerBoardRows(placement?.boards), contact, now)
}

const offerBoardRows = (boards) => (Array.isArray(boards) ? boards : [])
  .filter((b) => b && b.mode === 'derived' && OFFER_MODULES.includes(b.module))

/**
 * PIPEBUILD.3h — the Class Pack guard for the sync paths that skip placement
 * (the detail backfill: skipBookings + skipReclassify), which must still
 * decide the stamp. Live when the €39 claim over every purchase is live, or a
 * trial_purchase offer board at the studio holds a live claim over them (its
 * own duration and windows). The boards are read only when the contact has a
 * purchase whose €39 claim is not live: no purchase, or a live one, is today's
 * one read. Any failed read is { ok: false } and the caller keeps the guard
 * live (no stamp this sync).
 * @returns {Promise<{ ok: true, live: boolean } | { ok: false, reason: string }>}
 */
export async function loadPackGuardForContact(db, { locationId, contactId, contact, now = Date.now() }) {
  const res = await readContactPurchases(db, { locationId, contactId })
  if (!res.ok) return { ok: false, reason: res.reason }
  const claim = paidTrialClaim(res.purchases, now)
  if (!claim) return { ok: true, live: false }
  if (paidClaimLive(claim, contact, now)) return { ok: true, live: true }
  const boardsRes = await loadBoardsForLocation(db, locationId)
  if (!boardsRes.ok) return { ok: false, reason: boardsRes.reason }
  return { ok: true, live: liveTrialPurchaseOfferFromPurchases(res.purchases, offerBoardRows(boardsRes.boards), contact, now) }
}
