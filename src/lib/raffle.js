// RAFFLE.1 — a raffle on a charity event, sold in person at a till.
//
// Spec: docs/superpowers/specs/2026-11-20-charity-raffle-design.md.
//
// THE ONE RULE THAT MATTERS: the raffle never touches sales. A sale writes
// only the raffle tables (via sell_raffle_tickets, mig 864). It never creates
// a contact, never changes a contact's stage, tags or lead source, and never
// fires a sequence, a Glofox lead or a "New lead" push. A buyer who is not a
// contact is a guest: name + email on the sale row, nothing else.
//
// Access: `races` at the EVENT's studio (the donations and waitlist rule);
// voiding a sale and marking a draw "not claimed" also need MANAGER_ROLES
// there, because those are the two ways to change a result. An event at a
// studio the caller cannot see is a 404.

import { randomInt } from 'node:crypto'
import { NextResponse } from 'next/server'
import { createServerClient } from './supabase'
import { assertLocationAccessOr404, hasRoleAtLocation } from './auth'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from './permissions'
import { MANAGER_ROLES, uuidLike } from './schemas'
import { logError } from './log'

export const RAFFLE_COLS = 'id, race_event_id, location_id, name, ticket_price_cents, currency, sales_open, email_subject, email_intro, next_ticket_number, created_at'
export const SALE_COLS = 'id, raffle_id, contact_id, buyer_name, buyer_email, quantity, total_cents, payment_method, first_ticket, last_ticket, sold_by, voided_at, void_reason, email_status, email_sent_at, created_at'
export const DRAW_COLS = 'id, raffle_id, prize_name, ticket_id, drawn_at, unclaimed_at, unclaimed_note'

const EVENT_COLS = 'id, name, location_id, host_id, sending_location_id, accent_hex, hero_image_url, race_date'
const PAGE = 1000
const MAX_ROWS = 10000

export { formatTicketNumber, formatTicketRange, formatEuros } from './raffle-format'

/**
 * The last nine digits of a phone search, so `+353 87 123 4567`,
 * `087 123 4567` and `0871234567` all match the same stored number.
 * Null when the text has fewer than six digits (it is a name or an email).
 */
export function phoneDigitsTail(s) {
  const digits = String(s || '').replace(/\D/g, '')
  if (digits.length < 6) return null
  return digits.slice(-9)
}

/** A uniformly random index in [0, length), from a CSPRNG. */
export function pickRandomIndex(length, rand = randomInt) {
  if (!Number.isInteger(length) || length < 1) throw new RangeError('pickRandomIndex: nothing to pick from')
  return rand(0, length)
}

/** First name and last initial, for the room: "Sarah B." */
export function publicWinnerName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return ''
  if (parts.length === 1) return parts[0]
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`
}

/** Totals over the sales that count (voided sales do not). */
export function raffleTotals(sales) {
  const t = { cents: 0, tickets: 0, sales: 0, cashCents: 0, cardCents: 0 }
  for (const s of sales || []) {
    if (s.voided_at) continue
    t.cents += s.total_cents
    t.tickets += s.quantity
    t.sales += 1
    if (s.payment_method === 'cash') t.cashCents += s.total_cents
    else t.cardCents += s.total_cents
  }
  return t
}

const json = (status, body) => NextResponse.json(body, { status })
const notFound = () => json(404, { success: false, error: 'Not found' })
const forbidden = () => json(403, { success: false, error: 'Forbidden' })

/**
 * The staff gate for every raffle route.
 * @param {object|null} user  getCurrentUser()'s answer
 * @param {string} eventId
 * @param {{ manager?: boolean }} [opts]  manager: also require MANAGER_ROLES
 * @returns {Promise<{ response: Response } | { db: object, race: object, isManager: boolean }>}
 */
export async function resolveStaffRaffleEvent(user, eventId, { manager = false } = {}) {
  if (!user) return { response: json(401, { success: false, error: 'Unauthorised' }) }
  if (!hasPermissionAtAnyLocation(user, 'races')) return { response: forbidden() }
  if (!uuidLike.safeParse(eventId).success) return { response: notFound() }
  const db = createServerClient()
  const { data: race, error } = await db.from('race_events').select(EVENT_COLS).eq('id', eventId).maybeSingle()
  if (error) {
    logError('raffle', 'event read failed', { err: error, eventId })
    return { response: json(500, { success: false, error: 'The event could not be read. Try again.' }) }
  }
  if (!race?.location_id) return { response: notFound() }
  const guard = assertLocationAccessOr404(user, race.location_id)
  if (guard) return { response: guard }
  if (!hasPermissionForLocation(user, race.location_id, 'races')) return { response: forbidden() }
  const isManager = !!hasRoleAtLocation(user, race.location_id, MANAGER_ROLES)
  if (manager && !isManager) return { response: forbidden() }
  return { db, race, isManager }
}

/** The event's raffle row, or null. */
export async function loadRaffle(db, race) {
  return db.from('raffles').select(RAFFLE_COLS)
    .eq('race_event_id', race.id).eq('location_id', race.location_id)
    .maybeSingle()
}

async function readAll(build) {
  const rows = []
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1)
    if (error) return { error }
    rows.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return { rows }
}

/** Every sale of a raffle, newest first. */
export function listSales(db, raffleId) {
  return readAll(() => db.from('raffle_sales').select(SALE_COLS).eq('raffle_id', raffleId).order('created_at', { ascending: false }))
}

/** Every ticket of a raffle with its sale's buyer and void state. */
export function listTickets(db, raffleId) {
  return readAll(() => db.from('raffle_tickets').select('id, ticket_number, sale_id').eq('raffle_id', raffleId).order('ticket_number', { ascending: true }))
}

/** Every draw, oldest first. */
export function listDraws(db, raffleId) {
  return readAll(() => db.from('raffle_draws').select(DRAW_COLS).eq('raffle_id', raffleId).order('drawn_at', { ascending: true }))
}

/**
 * The page's whole state: the raffle (or null), its sales, its draws with the
 * winning ticket number and buyer, and the totals.
 */
export async function loadRaffleState(db, race) {
  const { data: raffle, error } = await loadRaffle(db, race)
  if (error) return { error }
  if (!raffle) return { raffle: null, sales: [], draws: [], totals: raffleTotals([]) }
  const [sales, draws] = await Promise.all([listSales(db, raffle.id), listDraws(db, raffle.id)])
  if (sales.error) return { error: sales.error }
  if (draws.error) return { error: draws.error }

  let drawRows = draws.rows
  if (drawRows.length) {
    const { data: tickets, error: tErr } = await db.from('raffle_tickets')
      .select('id, ticket_number, sale_id').eq('raffle_id', raffle.id)
      .in('id', drawRows.map((d) => d.ticket_id))
    if (tErr) return { error: tErr }
    const ticketById = new Map((tickets || []).map((t) => [t.id, t]))
    const saleById = new Map(sales.rows.map((s) => [s.id, s]))
    drawRows = drawRows.map((d) => {
      const t = ticketById.get(d.ticket_id)
      const s = t ? saleById.get(t.sale_id) : null
      return { ...d, ticket_number: t?.ticket_number ?? null, buyer_name: s?.buyer_name ?? '', winner_display: publicWinnerName(s?.buyer_name) }
    })
  }
  return { raffle, sales: sales.rows, draws: drawRows, totals: raffleTotals(sales.rows) }
}
