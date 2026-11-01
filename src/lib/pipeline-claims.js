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
import { paidTrialClaim } from '../../shared/pipelines/paid-trial.js'
import { matchProgrammeSignal, programmeClaimLive } from '../../shared/pipelines/programmes.js'
import { BOARD_KEYS, CLAIM_BOARD_MODULES } from '../../shared/pipelines/router.js'

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

/** A location's ENABLED boards. */
export async function loadBoardsForLocation(db, locationId) {
  const { data, error } = await db
    .from('pipelines')
    .select('id, key, module, mode, enabled, is_primary')
    .eq('location_id', locationId)
    .eq('enabled', true)
  if (error) {
    logWarn('pipeline-claims', 'pipelines read failed', { locationId, err: bounded(error) })
    return { ok: false, reason: 'boards_unreadable', err: bounded(error) }
  }
  return { ok: true, boards: Array.isArray(data) ? data : [] }
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

const PURCHASE_COLS = 'id, contact_id, status, payment_status, paid_at, granted_at, duration_days'
const CLAIM_COLS = 'contact_id, claimed_at, source'

const toProgrammeClaim = (row) => {
  const ms = Date.parse(row?.claimed_at)
  return Number.isFinite(ms) ? { claimedAt: ms, source: row.source ?? null } : null
}

/**
 * Every claim at a location, keyed by contact id, limited to `contactIds`
 * (the run's contact set: a Hatch-home buyer of the Stillorgan trial is not
 * in it, and is placed only as today — spec, Routing).
 *
 * @returns {Promise<{ ok: true, paidByContact: Map, programmeByContact: Map }
 *   | { ok: false, reason: 'purchases_unreadable'|'claims_unreadable', err: string }>}
 */
export async function loadClaimsForLocation(db, { locationId, contactIds, now = Date.now() }) {
  const wanted = contactIds instanceof Set ? contactIds : new Set(contactIds || [])

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
  for (const p of purchases) {
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
 * The programme claims to record: a contact with no claim who matches, or a
 * LAPSED claim (no longer live for this contact) a newer lead-source touch
 * renews — "a second /50plus signup after the claim went quiet" (spec). A live
 * claim is never reset: a 1st Class Done lead who re-submits the page to book
 * again stays at 1st Class Done. A plan match never renews (a plan carries no
 * date). Pure.
 *
 * @returns {Array<{ contact_id: string, board_key: string, claimed_at: string, source: string }>}
 */
export function pendingProgrammeClaims(contacts, programmeByContact, rules, now = Date.now()) {
  const out = []
  const stored = programmeByContact instanceof Map ? programmeByContact : new Map()
  for (const c of contacts || []) {
    if (!c?.id) continue
    const signal = matchProgrammeSignal(c, rules, now)
    if (!signal) continue
    const existing = stored.get(c.id)
    if (existing) {
      if (signal.source !== 'lead_source') continue
      if (!(signal.claimedAt > existing.claimedAt)) continue
      if (programmeClaimLive(existing, c, now)) continue
    }
    out.push({ contact_id: c.id, board_key: PROGRAMME_BOARD, claimed_at: new Date(signal.claimedAt).toISOString(), source: signal.source })
  }
  return out
}

/** Record claims (upsert on the PK). Never throws. */
export async function upsertProgrammeClaims(db, locationId, rows, now = Date.now()) {
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

/**
 * One contact's claims, for the webhook and Cold paths. Records a pending
 * programme claim when `write` is true; a failed WRITE still returns the claim
 * (the nightly pass records it again), a failed READ is reported.
 *
 * @returns {Promise<{ ok: true, claims: { paid: object|null, programme: { claimedAt:number, source:string|null }|null } }
 *   | { ok: false, reason: string, err?: string }>}
 */
export async function loadClaimsForContact(db, { locationId, contactId, contact, now = Date.now(), rules = EMPTY_RULES, write = true }) {
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

  const paid = paidTrialClaim(Array.isArray(purchases) ? purchases : [], now)
  const stored = Array.isArray(claimRows) && claimRows[0] ? toProgrammeClaim(claimRows[0]) : null
  const storedMap = new Map(stored ? [[contactId, stored]] : [])
  const pending = pendingProgrammeClaims([{ ...(contact || {}), id: contactId }], storedMap, rules, now)
  let programme = stored
  if (pending.length > 0) {
    programme = { claimedAt: Date.parse(pending[0].claimed_at), source: pending[0].source }
    if (write) await upsertProgrammeClaims(db, locationId, pending, now)
  }
  return { ok: true, claims: { paid, programme } }
}

/**
 * PIPE3.7 — everything a single placement (webhook, Cold, place-now) needs in
 * one call: the studio's enabled boards, and, when one of them is a claim
 * board, this contact's claims (recording a new programme match). A studio
 * with no claim board answers { claimBoards: false, claims: null } after the
 * one boards read and nothing else.
 *
 * @returns {Promise<{ ok: true, boards: object[], claimBoards: boolean, claims: { paid, programme }|null }
 *   | { ok: false, reason: string, boards?: object[] }>}
 */
export async function loadPlacementClaims(db, { locationId, contactId, contact, now = Date.now(), write = true }) {
  const boardsRes = await loadBoardsForLocation(db, locationId)
  if (!boardsRes.ok) return { ok: false, reason: boardsRes.reason }
  const boards = boardsRes.boards
  const claimBoards = boards.some((b) => b.mode === 'derived' && CLAIM_BOARD_MODULES.includes(b.module))
  if (!claimBoards) return { ok: true, boards, claimBoards: false, claims: null }
  const rulesRes = await loadProgrammeRules(db, locationId)
  if (!rulesRes.ok) return { ok: false, reason: rulesRes.reason, boards }
  const claimsRes = await loadClaimsForContact(db, { locationId, contactId, contact, now, rules: rulesRes.rules, write })
  if (!claimsRes.ok) return { ok: false, reason: claimsRes.reason, boards }
  return { ok: true, boards, claimBoards: true, claims: claimsRes.claims }
}

/**
 * PIPE3 fix pass — this contact's PAID claim alone, one indexed read. For the
 * sync paths that skip placement (the detail backfill: skipBookings +
 * skipReclassify) and must still decide the Class Pack stamp: a live €39 claim
 * means the credits are the trial's. Independent of the studio's boards: the
 * purchase row is the fact.
 * @returns {Promise<{ ok: true, claim: object|null } | { ok: false, reason: 'purchases_unreadable', err: string }>}
 */
export async function loadPaidClaimForContact(db, { locationId, contactId, now = Date.now() }) {
  const { data, error } = await db
    .from('trial_purchases')
    .select(PURCHASE_COLS)
    .eq('location_id', locationId)
    .eq('contact_id', contactId)
  if (error) {
    logWarn('pipeline-claims', 'trial_purchases read failed', { locationId, contactId, err: bounded(error) })
    return { ok: false, reason: 'purchases_unreadable', err: bounded(error) }
  }
  return { ok: true, claim: paidTrialClaim(Array.isArray(data) ? data : [], now) }
}
