// EVENT-WAITLIST.1 — the waitlist for a sold-out event (mig 713).
//
// One list per EVENT, not per time (Richard, 9 Oct). When any time of the
// event has room, EVERYONE waiting is offered at once and the first to
// complete a booking wins: the register route stays the arbiter (its own
// capacity gate), nothing here holds a place, and the claim token on the
// offer link only marks the row claimed once a booking went through.
//
//   joinWaitlist                the public form (and later staff/agent): find-
//                               or-create the contact the way the register
//                               route does, upsert the row, send the fixed
//                               "you're on the list" email.
//   runWaitlistOffers           the offer round (cron every 10 min, and staff /
//                               host "Offer now" for one event): expire rows of
//                               past events, then for each event with room offer
//                               every row not offered in the last 24 h, by
//                               email always and by WhatsApp when there is a
//                               phone and an APPROVED `event_waitlist_offer`
//                               template at the event's location.
//   claimWaitlistOnRegistration the register route, when the body carries a
//                               waitlist_token.
//
// 🔴 NEVER let the count or the list reach the public, nor any capacity:
// eventHasRoom answers a boolean, and the public routes only ever say "you're
// on the list" or "spots are available".
//
// Every send is best-effort and every failure is logged and counted: one bad
// row never stops a round.

import { sendTransactionalEmail } from './postmark'
import { formatWeekdayLongDateInTZ } from './dates'
import { getAppUrl } from './app-url'
import { resolveCustomerBaseUrl } from './tenant-host'
import { buildEventEmailShell, resolveEventEmail, resolveEventBrand, escapeHtml } from './event-email'
import { resolveEventCommsLocation, pickAudienceVenueName } from './event-comms-location'
import { checkTransactionalConsent, transactionalWhatsappSuppression } from './transactional-consent'
import { maybeSendBookingWhatsappConfirm } from './automations/booking-whatsapp-confirm'
import { findOrCreateRaceContact } from './race-contact-linking'
import { resolveMasterLocationId } from './host-events'
import { loadForMode } from './event-signups'
import { LIVE_REGISTRATION_STATUSES } from './audience-filter'
import { isWhatsAppNumberMissing } from './whatsapp-number-missing'
import { dublinTodayStr } from './dublin-time'
import { signWaitlistClaimToken, verifyWaitlistClaimToken, waitlistTokenSecret } from './event-waitlist-tokens'
import { logError, logWarn } from './log'

/** The WhatsApp template the offer goes out on. Richard creates it in Meta (UTILITY; body {{1}} name, {{2}} event, {{3}} link). */
export const WAITLIST_OFFER_TEMPLATE = 'event_waitlist_offer'
/** At most one offer per row per this long. */
export const OFFER_COOLDOWN_MS = 24 * 3600 * 1000
/** Rows still on the list. */
export const ACTIVE_WAITLIST_STATUSES = Object.freeze(['waiting', 'offered'])

const PAGE = 1000
const ID_CHUNK = 100

/** The row columns every reader here needs. */
export const WAITLIST_ROW_COLUMNS =
  'id, race_event_id, location_id, contact_id, name, email, phone, headcount, status, source, last_offered_at, offer_count, claimed_registration_id, removed_by_name, created_at'

/** The event columns the offer round and the join need. */
export const WAITLIST_EVENT_COLUMNS = `
  id, name, slug, kind, race_date, capacity_mode, active, status,
  location_id, host_id, sending_location_id,
  registration_opens_at, registration_closes_at,
  venue_name, accent_hex, hero_image_url,
  waitlist_email_subject, waitlist_email_intro,
  locations:location_id ( id, name, is_host_anchor, organization_id ),
  waves:race_waves ( id, capacity )
`

export function normaliseWaitlistEmail(email) {
  return typeof email === 'string' ? email.toLowerCase().trim() : ''
}

/**
 * Does any time of this event have room for one more? The public event
 * route's arithmetic (its `is_full` per wave, confirmed-only): a wave with no
 * capacity always has room, and an event with no waves is not full. Pure.
 *
 * NOTE the difference from the register route's gate: in people mode that
 * gate also counts pending_payment entries (a checkout in progress HOLDS its
 * place), this does not. So an offer can go out for a place a pending
 * checkout is holding; the register route then refuses the booking
 * (wave_full) and the person stays on the list. Kept confirmed-only so the
 * waitlist and the public page's "Sold out" agree on what full means.
 *
 * @param {{ capacity_mode?: string, waves?: Array<{ id: string, capacity?: number|null }> }} event
 * @param {Array<{ wave_id?: string|null, status?: string, team?: { size?: number }|null }>} registrations
 * @returns {boolean}
 */
export function eventHasRoom(event, registrations) {
  const waves = Array.isArray(event?.waves) ? event.waves : []
  if (waves.length === 0) return true
  const mode = event?.capacity_mode === 'people' ? 'people' : 'teams'
  const regs = (Array.isArray(registrations) ? registrations : []).filter((r) => r?.status === 'confirmed')
  return waves.some((w) => {
    if (w?.capacity == null || !Number.isFinite(w.capacity)) return true
    const inWave = regs.filter((r) => r.wave_id === w.id)
    return loadForMode(inWave, mode) < w.capacity
  })
}

/**
 * Is the event's registration window open right now? (The public route's
 * not_yet_open / closed states.) Pure.
 */
export function registrationWindowOpen(event, now = Date.now()) {
  const opensAt = event?.registration_opens_at ? Date.parse(event.registration_opens_at) : null
  const closesAt = event?.registration_closes_at ? Date.parse(event.registration_closes_at) : null
  if (opensAt && now < opensAt) return false
  if (closesAt && now > closesAt) return false
  return true
}

/** Is this row due an offer? Never offered, or the last one is 24 h old. Pure. */
export function isOfferDue(row, now = Date.now()) {
  if (!row || !ACTIVE_WAITLIST_STATUSES.includes(row.status)) return false
  if (!row.last_offered_at) return true
  const last = Date.parse(row.last_offered_at)
  return !Number.isFinite(last) || now - last >= OFFER_COOLDOWN_MS
}

/**
 * The confirmed registrations of one event (wave + team size), range-paginated.
 * @returns {Promise<{ data: Array|null, error: object|null }>}
 */
export async function readConfirmedRegistrations(db, raceEventId) {
  const out = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('race_registrations')
      .select('id, wave_id, status, team:teams ( size )')
      .eq('race_event_id', raceEventId)
      .eq('status', 'confirmed')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) return { data: null, error }
    out.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return { data: out, error: null }
}

/**
 * eventHasRoom for an event row that carries its waves, reading its
 * registrations. hasRoom is null when the read failed.
 */
export async function loadEventHasRoom(db, event) {
  const { data, error } = await readConfirmedRegistrations(db, event.id)
  if (error) return { hasRoom: null, error }
  return { hasRoom: eventHasRoom(event, data), error: null }
}

/**
 * The offer link: the event's normal signup page, carrying the claim token.
 * W1.L3b — `baseUrl` is the EVENT LOCATION's tenant host (sendWaitlistOffer
 * resolves it); without one it floors to the CRM host as before.
 */
export function waitlistClaimUrl(slug, waitlistId, now = Date.now(), handed = null) {
  const token = signWaitlistClaimToken({ waitlistId, now }, waitlistTokenSecret())
  const baseUrl = (typeof handed === 'string' && handed.replace(/\/+$/, '')) || getAppUrl()
  return `${baseUrl}/event/${encodeURIComponent(slug)}?wl=${encodeURIComponent(token)}`
}

function fmtDate(dateStr) {
  if (!dateStr) return ''
  return formatWeekdayLongDateInTZ(dateStr) || dateStr
}

function firstNameOf(name) {
  return String(name || '').trim().split(/\s+/)[0] || ''
}

function infoRowsFor(ctx) {
  const row = (label, value) => `<tr><td style="padding:8px 0;color:#666;width:120px">${label}</td><td style="padding:8px 0;font-weight:600">${escapeHtml(value)}</td></tr>`
  return [
    `    ${row('Event', ctx.eventName)}`,
    ctx.dateLabel ? `    ${row('Date', ctx.dateLabel)}` : '',
    ctx.locationName ? `    ${row('Where', ctx.locationName)}` : '',
  ].filter(Boolean).join('\n')
}

function contextFor(race, row) {
  return {
    eventName: race?.name || 'the event',
    dateLabel: fmtDate(race?.race_date),
    locationName: pickAudienceVenueName({ venueName: race?.venue_name, eventLocation: race?.locations }) || '',
    firstName: firstNameOf(row?.name),
  }
}

/**
 * The "you're on the list" email. FIXED transactional copy (a short receipt
 * for something the person just did on the page, not a message an operator
 * writes), so it is not operator-editable; the event's header styling still
 * applies. Exported for the tests.
 */
export function buildWaitlistJoinedEmail(ctx, race = {}) {
  const who = escapeHtml(ctx.firstName || 'there')
  const subject = `You're on the waitlist for ${ctx.eventName}`
  const htmlBody = buildEventEmailShell({
    heading: `You're on the list, ${who}.`,
    introHtml: `We'll let you know if a spot opens up for <strong>${escapeHtml(ctx.eventName)}</strong>.`,
    accentHex: race.accent_hex ?? null,
    headerImageUrl: race.hero_image_url ?? null,
    infoRows: infoRowsFor(ctx),
    footerHtml: `If a spot opens, we'll email you (and WhatsApp you if you gave a number). The first to book gets it, so it's worth acting quickly.`,
    locationName: ctx.locationName,
    brand: ctx.brand || '',
  })
  return { subject, htmlBody }
}

/**
 * Default shell slots for the offer email. The grey box (footerHtml) is the
 * operator-editable part (race_events.waitlist_email_intro, merge tag
 * {{claim_url}}); the button and the link are always there.
 */
export function buildWaitlistOfferDefaults(ctx) {
  const who = escapeHtml(ctx.firstName || 'there')
  const href = escapeHtml(ctx.claimUrl || '')
  return {
    subject: `A spot opened up for ${ctx.eventName}`,
    heading: `A spot opened up, ${who}.`,
    introHtml: `A place has come free at <strong>${escapeHtml(ctx.eventName)}</strong>.`,
    infoRows: infoRowsFor(ctx),
    memberQrs: [],
    afterInfoHtml: `

  <p style="margin:0 0 12px;text-align:center"><a href="${href}" style="display:inline-block;background:#111;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px">Book now</a></p>
  <p style="margin:0 0 24px;text-align:center;color:#666;font-size:12px;word-break:break-all">Or open this link: ${href}</p>`,
    footerHtml: `It goes to the first person to book. If it's gone by the time you look, you stay on the list.`,
    locationName: ctx.locationName,
  }
}

async function commsLocationIdFor(db, race, meta) {
  // Same fallback as race-confirmations: a resolver failure never costs the email.
  let commsLocation = null
  try {
    commsLocation = await resolveEventCommsLocation(db, { location_id: race.location_id, host_id: race.host_id, sending_location_id: race.sending_location_id })
  } catch (e) {
    logError('event-waitlist', 'comms location resolver threw; sending from the event location', { err: e, ...meta })
  }
  return commsLocation?.id || race.location_id || null
}

/**
 * Send the "you're on the list" email. Never throws.
 * @returns {Promise<'sent'|string>} 'sent', or `skipped:<reason>` / `failed`
 */
export async function sendWaitlistJoinedEmail(db, { race, row }) {
  try {
    if (!row?.email) return 'skipped:no_email'
    // Recoverable: the page already told them they are on the list.
    const gate = await checkTransactionalConsent({ db, contactId: row.contact_id, channel: 'email', module: 'event-waitlist', meta: { waitlistId: row.id } })
    if (!gate.allowed) return `skipped:${gate.reason}`
    const locationId = await commsLocationIdFor(db, race, { waitlistId: row.id })
    // W1.S1a — the shell carries the SENDING location's brand.
    const ctx = { ...contextFor(race, row), brand: await resolveEventBrand(db, {}, locationId) }
    const { subject, htmlBody } = buildWaitlistJoinedEmail(ctx, race)
    await sendTransactionalEmail({ to: row.email, subject, htmlBody, contactId: row.contact_id || null, locationId, tag: 'event-waitlist-joined' })
    return 'sent'
  } catch (e) {
    logError('event-waitlist', 'joined email failed to send', { err: e, waitlistId: row?.id })
    return 'failed'
  }
}

/**
 * Join (or re-join) an event's waitlist. One row per (event, email): a row
 * still on the list is refreshed in place (no second email); a removed,
 * expired or claimed row is reset to waiting. The contact is found or created
 * the way the register route does it (host events: at the org master, exempt
 * from automations).
 *
 * @param {object} db  service-role client
 * @param {{ race: object, name: string, email: string, phone?: string|null, headcount?: number,
 *   consent?: boolean, ip?: string|null, source?: 'public'|'staff'|'host'|'agent' }} args
 * @returns {Promise<{ row: object, created: boolean, rejoined: boolean } | { error: string }>}
 */
export async function joinWaitlist(db, { race, name, email, phone = null, headcount = 1, consent, ip = null, source = 'public' }) {
  const cleanEmail = normaliseWaitlistEmail(email)
  const cleanName = String(name || '').trim()
  if (!race?.id || !race.location_id || !cleanEmail || !cleanName) return { error: 'invalid' }
  const cleanPhone = phone ? String(phone).trim() || null : null
  const size = Number.isInteger(headcount) && headcount >= 1 && headcount <= 50 ? headcount : 1

  // HOST-MASTER.4 — mirror the register route: a host event's contacts live
  // at the org master location, exempt from automations on create.
  let contactLocationId = race.location_id
  let insertFields = {}
  if (race.host_id) {
    const { data: host, error: hostErr } = await db
      .from('event_hosts')
      .select('id, organization_id, anchor_location_id')
      .eq('id', race.host_id)
      .maybeSingle()
    if (hostErr) logWarn('event-waitlist', 'host read failed; contact placed at the event location', { err: hostErr, raceId: race.id })
    if (host) {
      contactLocationId = (await resolveMasterLocationId(db, host)) || race.location_id
      insertFields = { automations_exempt: true }
    }
  }

  let contactId = null
  try {
    contactId = await findOrCreateRaceContact({ db, locationId: contactLocationId, email: cleanEmail, name: cleanName, phone: cleanPhone, insertFields })
  } catch (e) {
    logWarn('event-waitlist', 'contact find-or-create failed; joining without a contact', { err: e, raceId: race.id })
  }

  // CONSENT.4 — the same soft opt-in as the register form, applied when the
  // person answered the checkbox. Best-effort.
  if (contactId && typeof consent === 'boolean') {
    try {
      const { applyFormMarketingConsent } = await import('./marketing-consent')
      await applyFormMarketingConsent(db, { contactId, consent, source: 'event_form', ipAddress: ip, locationId: contactLocationId })
    } catch (e) {
      logWarn('event-waitlist', 'marketing consent write error', { err: e })
    }
  }

  const fields = {
    name: cleanName,
    phone: cleanPhone,
    headcount: size,
    ...(contactId ? { contact_id: contactId } : {}),
    ...(typeof consent === 'boolean' ? { marketing_consent: consent } : {}),
  }

  const readExisting = () => db
    .from('event_waitlist')
    .select(WAITLIST_ROW_COLUMNS)
    .eq('race_event_id', race.id)
    .eq('email', cleanEmail)
    .maybeSingle()

  let { data: existing, error: readErr } = await readExisting()
  if (readErr) {
    logError('event-waitlist', 'waitlist read failed', { err: readErr, raceId: race.id })
    return { error: 'load_failed' }
  }

  let row = null
  let created = false
  let rejoined = false
  if (!existing) {
    const { data, error } = await db
      .from('event_waitlist')
      .insert({ race_event_id: race.id, location_id: race.location_id, email: cleanEmail, source, ...fields })
      .select(WAITLIST_ROW_COLUMNS)
      .single()
    if (error && error.code === '23505') {
      // A double submit raced us to the unique key: treat it as the existing row.
      ;({ data: existing, error: readErr } = await readExisting())
      if (readErr || !existing) {
        logError('event-waitlist', 'waitlist re-read after 23505 failed', { err: readErr, raceId: race.id })
        return { error: 'write_failed' }
      }
    } else if (error) {
      logError('event-waitlist', 'waitlist insert failed', { err: error, raceId: race.id })
      return { error: 'write_failed' }
    } else {
      row = data
      created = true
    }
  }

  if (!row) {
    const stillOn = ACTIVE_WAITLIST_STATUSES.includes(existing.status)
    // Still on the list: the form is public and anyone can type this email,
    // so never overwrite the name, and only FILL a missing phone or contact.
    // Off the list (removed / expired / claimed): a fresh join, fresh details.
    const patch = stillOn
      ? {
          headcount: size,
          ...(existing.phone ? {} : (cleanPhone ? { phone: cleanPhone } : {})),
          ...(existing.contact_id || !contactId ? {} : { contact_id: contactId }),
          ...(typeof consent === 'boolean' ? { marketing_consent: consent } : {}),
        }
      : { ...fields, status: 'waiting', last_offered_at: null, removed_by_name: null }
    const { data, error } = await db
      .from('event_waitlist')
      .update(patch)
      .eq('id', existing.id)
      .select(WAITLIST_ROW_COLUMNS)
      .single()
    if (error) {
      logError('event-waitlist', 'waitlist update failed', { err: error, waitlistId: existing.id })
      return { error: 'write_failed' }
    }
    row = data
    rejoined = !stillOn
  }

  if (created || rejoined) await sendWaitlistJoinedEmail(db, { race, row })
  return { row, created, rejoined }
}

/**
 * Send one offer: email always (the ADMINISTRATIVE consent gate, recoverable:
 * the cron re-runs every 10 minutes and offers again after 24 h, so a
 * suppression is not the last word), WhatsApp when there is a phone, a
 * contact, and an APPROVED `event_waitlist_offer` template at the event's
 * location, and the contact's WhatsApp state allows it. Never throws.
 *
 * `commsLocationId` is the sending location, resolved once per event by the
 * round; resolved here when not given.
 *
 * @returns {Promise<{ email: string, whatsapp: string }>} each 'sent',
 *   'skipped:<reason>' or 'failed'
 */
export async function sendWaitlistOffer(db, { race, row, now = Date.now(), commsLocationId = null }) {
  const out = { email: 'skipped:no_email', whatsapp: 'skipped:no_phone' }
  let claimUrl
  try {
    // W1.L3b — both legs (email + the WhatsApp body param) carry the link on
    // the event location's tenant host; the resolver floors to the CRM host
    // and never throws past it, so this try fails exactly as it did before.
    const baseUrl = await resolveCustomerBaseUrl(db, race?.location_id || null)
    claimUrl = waitlistClaimUrl(race.slug, row.id, now, baseUrl)
  } catch (e) {
    logError('event-waitlist', 'claim link could not be built; offer not sent', { err: e, waitlistId: row.id })
    return { email: 'failed', whatsapp: 'failed' }
  }
  const ctx = { ...contextFor(race, row), claimUrl }

  if (row.email) {
    try {
      const gate = await checkTransactionalConsent({
        db, contactId: row.contact_id, channel: 'email', module: 'event-waitlist', meta: { waitlistId: row.id },
      })
      if (!gate.allowed) {
        out.email = `skipped:${gate.reason}`
      } else {
        const contact = { first_name: ctx.firstName, name: row.name || '', email: row.email, phone: '' }
        const extras = { event_name: ctx.eventName, when: ctx.dateLabel, location: ctx.locationName, claim_url: claimUrl }
        const locationId = commsLocationId || await commsLocationIdFor(db, race, { waitlistId: row.id })
        const { subject, htmlBody } = await resolveEventEmail({ db, kind: 'waitlist', race, contact, extras, defaults: buildWaitlistOfferDefaults(ctx), brandLocationId: locationId })
        await sendTransactionalEmail({ to: row.email, subject, htmlBody, contactId: row.contact_id || null, locationId, tag: 'event-waitlist-offer' })
        out.email = 'sent'
      }
    } catch (e) {
      out.email = 'failed'
      logError('event-waitlist', 'offer email failed to send', { err: e, waitlistId: row.id })
    }
  }

  out.whatsapp = await sendWaitlistOfferWhatsapp(db, { race, row, ctx })
  return out
}

/**
 * The WhatsApp leg. Must never throw out of the round. A studio with no active
 * WhatsApp number of its own (WhatsAppNumberMissingError territory, CLAUDE.md)
 * is a quiet skip, `no_number`: checked up front from whatsapp_numbers (a
 * plain read, not a config resolver), and recognised again if the error ever
 * escapes the send helper. The helper swallows its own send errors; this
 * wrapper catches everything else.
 */
async function sendWaitlistOfferWhatsapp(db, { race, row, ctx }) {
  try {
    if (!row.phone) return 'skipped:no_phone'
    if (!row.contact_id) return 'skipped:no_contact'
    const { data: contact, error } = await db
      .from('contacts')
      .select('id, first_name, name, phone, wa_phone, wa_status, contact_preferences ( whatsapp_administrative )')
      .eq('id', row.contact_id)
      .maybeSingle()
    if (error) {
      logWarn('event-waitlist', 'contact read failed; WhatsApp offer not sent (the email carries it)', { err: error, waitlistId: row.id })
      return 'failed'
    }
    if (!contact) return 'skipped:no_contact'
    const suppression = transactionalWhatsappSuppression(contact)
    if (suppression) return `skipped:${suppression}`
    const { data: numbers, error: numErr } = await db
      .from('whatsapp_numbers')
      .select('id')
      .eq('location_id', race.location_id)
      .eq('is_active', true)
      .limit(1)
    if (numErr) {
      logWarn('event-waitlist', 'WhatsApp number read failed; WhatsApp offer not sent (the email carries it)', { err: numErr, waitlistId: row.id })
      return 'failed'
    }
    if (!numbers?.length) return 'skipped:no_number'
    const res = await maybeSendBookingWhatsappConfirm({
      db,
      locationId: race.location_id,
      contact: { id: contact.id, first_name: contact.first_name, name: contact.name, phone: row.phone, wa_phone: contact.wa_phone },
      templateName: WAITLIST_OFFER_TEMPLATE,
      bodyParams: [ctx.firstName || 'there', ctx.eventName, ctx.claimUrl],
    })
    if (res?.sent) return 'sent'
    if (res?.reason === 'send_failed') {
      logWarn('event-waitlist', 'WhatsApp offer not sent (logged skip; the email carries it)', { waitlistId: row.id, locationId: race.location_id })
      return 'failed'
    }
    return `skipped:${res?.reason || 'unknown'}`
  } catch (e) {
    if (isWhatsAppNumberMissing(e)) return 'skipped:no_number'
    logWarn('event-waitlist', 'WhatsApp offer threw; skipped', { err: e, waitlistId: row?.id })
    return 'failed'
  }
}

async function readActiveRows(db, eventId) {
  const rows = []
  for (let from = 0; ; from += PAGE) {
    let q = db.from('event_waitlist').select(WAITLIST_ROW_COLUMNS).in('status', ACTIVE_WAITLIST_STATUSES)
    if (eventId) q = q.eq('race_event_id', eventId)
    const { data, error } = await q.order('id', { ascending: true }).range(from, from + PAGE - 1)
    if (error) return { rows: null, error }
    rows.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return { rows, error: null }
}

/**
 * Claimed rows of events still ahead (race_date today or later), with their
 * registration, so the round can re-open a claim whose booking fell through.
 * Bounded by the event date: past events' claims are history and never read.
 */
async function readUpcomingClaimedRows(db, eventId, todayStr) {
  const rows = []
  for (let from = 0; ; from += PAGE) {
    let q = db
      .from('event_waitlist')
      .select(`${WAITLIST_ROW_COLUMNS}, race:race_events!inner ( race_date ), registration:claimed_registration_id ( id, status, race_event_id )`)
      .eq('status', 'claimed')
      .gte('race.race_date', todayStr)
    if (eventId) q = q.eq('race_event_id', eventId)
    const { data, error } = await q.order('id', { ascending: true }).range(from, from + PAGE - 1)
    if (error) return { rows: null, error }
    rows.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return { rows, error: null }
}

/**
 * The LIVE registrations (confirmed or pending payment) of one event, with the
 * lead's email: who already holds a place, and (confirmed only, inside
 * eventHasRoom) whether a place is free. Range-paginated.
 */
async function readLiveRegistrations(db, raceEventId) {
  const out = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('race_registrations')
      .select('id, wave_id, status, contact_id, team:teams ( size ), contact:contact_id ( email )')
      .eq('race_event_id', raceEventId)
      .in('status', LIVE_REGISTRATION_STATUSES)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) return { data: null, error }
    out.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return { data: out, error: null }
}

/** A claim whose registration is gone, no longer live, or moved to another event. */
export function claimFellThrough(row) {
  const reg = row?.registration
  if (!reg) return true
  if (!LIVE_REGISTRATION_STATUSES.includes(reg.status)) return true
  return reg.race_event_id !== row.race_event_id
}

async function readEvents(db, ids) {
  const events = new Map()
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const { data, error } = await db.from('race_events').select(WAITLIST_EVENT_COLUMNS).in('id', ids.slice(i, i + ID_CHUNK))
    if (error) return { events: null, error }
    for (const e of data || []) events.set(e.id, e)
  }
  return { events, error: null }
}

/**
 * The offer round. For every event with rows on the list (or claims to check):
 *   1. a past event's rows expire. An event with no date never expires (it has
 *      no day to pass; staff remove rows by hand);
 *   2. a claimed row whose booking fell through (registration cancelled,
 *      no_show, deleted, or moved to another event) is RE-OPENED: back to
 *      `offered`, claimed_registration_id cleared, logged, so it is offered
 *      again on the usual rule;
 *   3. a row whose contact or email already holds a LIVE registration on the
 *      event (they booked without the link) is marked `claimed` and not
 *      offered;
 *   4. an event that is published, active, open for registration and has room
 *      in at least one time offers every row due (never offered, or not in the
 *      last 24 h; `force` ignores the 24 h rule). One row's failure never stops
 *      the round.
 *
 * A row is stamped (status offered, last_offered_at, offer_count + 1) AFTER
 * its sends, whatever they did: sent, suppressed on every channel, or FAILED
 * on every channel (logged). So a dead address is retried once per 24 h by
 * the cron, never on every 10-minute tick.
 *
 * Throws only when the list itself cannot be read (the cron then withholds its
 * heartbeat stamp).
 *
 * @param {object} db  service-role client
 * @param {{ now?: number, todayStr?: string, eventId?: string, force?: boolean }} [opts]
 *   eventId limits the round to one event (staff / host "Offer now");
 *   force (only with "Offer now") ignores the 24 h rule for every row still on
 *   the list, never-offered and already-offered alike. The cron never forces.
 * @returns {Promise<{ events: number, offered: number, expired: number, skipped: number, failed: number, no_room: number, claimed: number, reopened: number }>}
 */
export async function runWaitlistOffers(db, { now = Date.now(), todayStr = dublinTodayStr(), eventId = null, force = false } = {}) {
  const counts = { events: 0, offered: 0, expired: 0, skipped: 0, failed: 0, no_room: 0, claimed: 0, reopened: 0 }

  const { rows: activeRows, error: rowsErr } = await readActiveRows(db, eventId)
  if (rowsErr) throw new Error(`event_waitlist read failed: ${rowsErr.message || rowsErr}`)
  const { rows: claimedRows, error: claimedErr } = await readUpcomingClaimedRows(db, eventId, todayStr)
  if (claimedErr) throw new Error(`event_waitlist claimed read failed: ${claimedErr.message || claimedErr}`)
  if (!activeRows.length && !claimedRows.length) return counts

  const byEvent = new Map()
  const bucket = (id) => {
    if (!byEvent.has(id)) byEvent.set(id, { active: [], claimed: [] })
    return byEvent.get(id)
  }
  for (const r of activeRows) bucket(r.race_event_id).active.push(r)
  for (const r of claimedRows) bucket(r.race_event_id).claimed.push(r)
  const { events, error: evErr } = await readEvents(db, [...byEvent.keys()])
  if (evErr) throw new Error(`race_events read failed: ${evErr.message || evErr}`)

  const nowIso = new Date(now).toISOString()
  for (const [raceEventId, group] of byEvent) {
    const race = events.get(raceEventId)
    if (!race) { counts.skipped += group.active.length; continue }

    // 1. The event date passed: the list is over. A NULL race_date never
    // matches, so such an event's rows never expire (see the header).
    if (race.race_date && race.race_date < todayStr) {
      if (!group.active.length) continue
      const { data, error } = await db
        .from('event_waitlist')
        .update({ status: 'expired' })
        .eq('race_event_id', raceEventId)
        .in('status', ACTIVE_WAITLIST_STATUSES)
        .select('id')
      if (error) {
        counts.failed += 1
        logError('event-waitlist', 'expiring a past event\'s waitlist failed', { err: error, raceEventId })
      } else {
        counts.expired += (data || []).length
      }
      continue
    }

    // 2. Re-open claims whose booking fell through.
    const active = [...group.active]
    for (const row of group.claimed) {
      if (!claimFellThrough(row)) continue
      let q = db
        .from('event_waitlist')
        .update({ status: 'offered', claimed_registration_id: null })
        .eq('id', row.id)
        .eq('status', 'claimed')
      q = row.claimed_registration_id ? q.eq('claimed_registration_id', row.claimed_registration_id) : q.is('claimed_registration_id', null)
      const { data, error } = await q.select(WAITLIST_ROW_COLUMNS)
      if (error) {
        counts.failed += 1
        logError('event-waitlist', 're-opening a claim whose booking fell through failed', { err: error, waitlistId: row.id })
        continue
      }
      if (!data?.length) continue
      logWarn('event-waitlist', 'claim re-opened: the booking fell through; back on the list', {
        waitlistId: row.id, registrationId: row.claimed_registration_id || null, registrationStatus: row.registration?.status || 'gone',
      })
      counts.reopened += 1
      active.push(data[0])
    }
    if (!active.length) continue

    const { data: liveRegs, error: regsErr } = await readLiveRegistrations(db, raceEventId)
    if (regsErr) {
      counts.failed += 1
      logError('event-waitlist', 'registrations read failed; event skipped this round', { err: regsErr, raceEventId })
      continue
    }

    // 3. Already booked (without the link): mark claimed, never offer.
    const byContact = new Map()
    const byEmail = new Map()
    for (const reg of liveRegs) {
      if (reg.contact_id) byContact.set(reg.contact_id, reg.id)
      const em = normaliseWaitlistEmail(reg.contact?.email)
      if (em) byEmail.set(em, reg.id)
    }
    const toOffer = []
    for (const row of active) {
      const regId = (row.contact_id && byContact.get(row.contact_id)) || byEmail.get(normaliseWaitlistEmail(row.email))
      if (!regId) { toOffer.push(row); continue }
      const { data, error } = await db
        .from('event_waitlist')
        .update({ status: 'claimed', claimed_registration_id: regId })
        .eq('id', row.id)
        .in('status', ACTIVE_WAITLIST_STATUSES)
        .select('id')
      if (error) {
        counts.failed += 1
        logError('event-waitlist', 'marking an already-booked row claimed failed; not offered', { err: error, waitlistId: row.id })
      } else if (data?.length) {
        counts.claimed += 1
      }
    }
    if (!toOffer.length) continue

    // 4. Offer, when the event is bookable and a place is free.
    if (!(race.active === true && race.status === 'published') || !registrationWindowOpen(race, now)) {
      counts.skipped += toOffer.length
      continue
    }
    if (!eventHasRoom(race, liveRegs)) { counts.no_room += 1; continue }
    counts.events += 1

    const due = toOffer.filter((row) => (force ? ACTIVE_WAITLIST_STATUSES.includes(row.status) : isOfferDue(row, now)))
    counts.skipped += toOffer.length - due.length
    if (!due.length) continue
    const commsLocationId = await commsLocationIdFor(db, race, { raceEventId })

    for (const row of due) {
      const res = await sendWaitlistOffer(db, { race, row, now, commsLocationId })
      const sent = res.email === 'sent' || res.whatsapp === 'sent'
      const failedAll = !sent && (res.email === 'failed' || res.whatsapp === 'failed')
      if (failedAll) {
        // Stamped below all the same: retried once per 24 h, not every tick.
        logError('event-waitlist', 'offer not delivered: every channel failed; next try in 24 h', { waitlistId: row.id, email: res.email, whatsapp: res.whatsapp })
      }

      const { data: stamped, error: stampErr } = await db
        .from('event_waitlist')
        .update({ status: 'offered', last_offered_at: nowIso, offer_count: (Number(row.offer_count) || 0) + 1 })
        .eq('id', row.id)
        .in('status', ACTIVE_WAITLIST_STATUSES)
        .select('id')
      if (stampErr) {
        // The offer went; only the bookkeeping failed. The next tick may offer
        // again (a duplicate, never a loss). Loud, so it is seen.
        logError('event-waitlist', 'offer sent but the row could not be stamped; it may be offered again', { err: stampErr, waitlistId: row.id })
      } else if (!stamped?.length) {
        logWarn('event-waitlist', 'row left the list while its offer went out', { waitlistId: row.id })
      }
      if (sent) counts.offered += 1
      else if (failedAll) counts.failed += 1
      else counts.skipped += 1
    }
  }
  return counts
}

/**
 * Mark the waitlist row named by a claim token as claimed by this
 * registration. Only a row of THIS event that is still on the list. Never
 * throws; a refusal is a reason, logged by the caller as it sees fit.
 *
 * @param {object} db
 * @param {{ token: string, registrationId: string, raceEventId: string, now?: number }} args
 * @returns {Promise<{ claimed: boolean, reason?: string, waitlistId?: string }>}
 */
export async function claimWaitlistOnRegistration(db, { token, registrationId, raceEventId, now = Date.now() }) {
  try {
    if (!token || !registrationId || !raceEventId) return { claimed: false, reason: 'missing' }
    const verified = verifyWaitlistClaimToken(token, waitlistTokenSecret(), { now })
    if (!verified) return { claimed: false, reason: 'invalid_token' }
    const { data, error } = await db
      .from('event_waitlist')
      .update({ status: 'claimed', claimed_registration_id: registrationId })
      .eq('id', verified.waitlistId)
      .eq('race_event_id', raceEventId)
      .in('status', ACTIVE_WAITLIST_STATUSES)
      .select('id')
    if (error) {
      logError('event-waitlist', 'claim write failed', { err: error, waitlistId: verified.waitlistId, registrationId })
      return { claimed: false, reason: 'write_failed', waitlistId: verified.waitlistId }
    }
    if (!data?.length) return { claimed: false, reason: 'not_on_list', waitlistId: verified.waitlistId }
    return { claimed: true, waitlistId: verified.waitlistId }
  } catch (e) {
    logError('event-waitlist', 'claim threw', { err: e, registrationId })
    return { claimed: false, reason: 'error' }
  }
}

/**
 * Mark this event's waitlist row for the booking's lead email as claimed by
 * the registration: they booked, with or without the offer link. Same CAS as
 * the token claim (only a row still on the list). Never throws.
 *
 * @param {object} db
 * @param {{ raceEventId: string, email: string, registrationId: string }} args
 * @returns {Promise<{ claimed: boolean, reason?: string, waitlistId?: string }>}
 */
export async function claimWaitlistByEmail(db, { raceEventId, email, registrationId }) {
  try {
    const cleanEmail = normaliseWaitlistEmail(email)
    if (!raceEventId || !cleanEmail || !registrationId) return { claimed: false, reason: 'missing' }
    const { data, error } = await db
      .from('event_waitlist')
      .update({ status: 'claimed', claimed_registration_id: registrationId })
      .eq('race_event_id', raceEventId)
      .eq('email', cleanEmail)
      .in('status', ACTIVE_WAITLIST_STATUSES)
      .select('id')
    if (error) {
      logError('event-waitlist', 'claim by email failed', { err: error, raceEventId, registrationId })
      return { claimed: false, reason: 'write_failed' }
    }
    if (!data?.length) return { claimed: false, reason: 'not_on_list' }
    return { claimed: true, waitlistId: data[0].id }
  } catch (e) {
    logError('event-waitlist', 'claim by email threw', { err: e, registrationId })
    return { claimed: false, reason: 'error' }
  }
}
