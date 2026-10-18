// Orchestrates the Flow data-exchange: prefill on INIT, resolve live days/slots
// on each step, thread state (path/slot) forward, and parse the completion.
// The chosen slot id encodes everything the booking needs (decoded at completion):
//   class:   `${event_id}|${starts_at}|${class_name}`
//   consult: `${event_id}|${date}|${start}|${end}`
import { computeAvailableSlots } from '@/lib/booking-slots.js'
import { listPublicClasses } from '@/lib/public-classes.js'
import { SCREEN, dayScreen, slotScreen, detailsScreen, confirmScreen } from './screens.js'
import { formatInZone, getLocationZone, LocationZoneReadError, DEFAULT_TZ } from '@/lib/location-time'
import { logWarn, logError } from '@/lib/log'
import { readUn1tWriteSettings } from '@/lib/un1t-online-settings'
import { un1tFunnelCopyFromBlocks, termsLabelText } from '@/lib/un1t-online-funnel-copy'
import { legalDocPathFor } from '@/lib/un1t-online-legal'
import { getAppUrl } from '@/lib/app-url'

const PING = { data: { status: 'active' } }

const asBool = (v) => v === true || v === 'true'
const FLOW_OPTIN_LABEL_MAX = 120

/**
 * UN1TWRITE.19 — does this studio's Flow need the un1t.online terms and
 * waiver accepted (a un1t.online studio with the funnel on), and in the
 * operator's words. The Flow is a live answer to Meta, so this never throws:
 * an unreadable settings row is "not required" (the processor still refuses
 * to create an account for a request with no recorded acceptance).
 * @returns {Promise<{ required: boolean, label?: string, url?: string, message?: string }>}
 */
export async function flowTermsFor(db, locationId) {
  let s
  try {
    s = await readUn1tWriteSettings(db, locationId)
  } catch (e) {
    logWarn('whatsapp-flow', 'un1t.online settings unreadable; terms not asked', { locationId, err: e })
    return { required: false }
  }
  if (s.membershipSource !== 'un1t_online' || !s.settings.funnelEnabled) return { required: false }
  let landing = null
  try {
    const { data, error } = await db.from('landing_page_settings').select('public_path, blocks').eq('location_id', locationId).maybeSingle()
    if (error) throw error
    landing = data
  } catch (e) {
    logWarn('whatsapp-flow', 'landing row unreadable; default terms copy used', { locationId, err: e })
  }
  const copy = un1tFunnelCopyFromBlocks(landing?.blocks)
  // Never ask someone to accept documents they cannot open: no link, no ask
  // (the processor then refuses to create an account without an acceptance).
  let url = ''
  try {
    if (landing?.public_path) url = `${getAppUrl()}${legalDocPathFor(landing.public_path, 'terms')}`
  } catch (e) {
    logWarn('whatsapp-flow', 'app url unset; terms link unavailable', { locationId, err: e })
  }
  if (!url) {
    logError('whatsapp-flow', 'un1t.online terms link unavailable; the Flow does not ask for the tick', { locationId })
    return { required: false }
  }
  // Meta caps an OptIn label; an operator's long label is cut, never refused.
  const label = termsLabelText(copy, { studioName: s.studioName }).slice(0, FLOW_OPTIN_LABEL_MAX)
  return { required: true, label, url, message: copy.terms_required_message }
}

async function resolveConsultEvent(db, locationId, config) {
  const { data: event } = await db.from('event_types')
    .select('id, name, slug, duration_minutes, buffer_minutes, availability, max_advance_days, location_id')
    .eq('location_id', locationId).eq('slug', config.consult_event_slug).eq('active', true).maybeSingle()
  return event
}

// TZ.5 — a day key ('YYYY-MM-DD') is a calendar date with no instant in it, so
// its title is labelled in UTC from a noon-UTC anchor: the date itself, in any
// zone (byte-identical to the old Dublin label for that anchor).
export function dayLabel(iso) {
  return formatInZone(new Date(`${iso}T12:00:00Z`), 'UTC', { weekday: 'short', day: 'numeric', month: 'short' })
}
// TZ.5 — a class start is an instant: shown on the studio's own clock.
export function timeLabel(iso, zone = DEFAULT_TZ) {
  return formatInZone(new Date(iso), zone, { hour: '2-digit', minute: '2-digit' })
}

// TZ.17 — a public class's calendar day is the studio's (`day`, rendered in the
// studio's zone by public-classes). The UTC fallback only serves a shape with no
// `day` (none in production: every listPublicClasses row carries one).
export function flowClassDay(c) {
  return c.day || c.starts_at.slice(0, 10)
}

// The Flow's data exchange is a live answer to Meta, so a failed zone read
// still answers: on DEFAULT_TZ, explicitly, with a warning (never silently).
async function flowZone(db, locationId) {
  try {
    return await getLocationZone(db, locationId)
  } catch (e) {
    if (!(e instanceof LocationZoneReadError)) throw e
    logWarn('whatsapp-flow', 'location zone unreadable; slot times shown on the platform zone', { locationId, err: e.cause || e })
    return DEFAULT_TZ
  }
}

// The Flow is class-only (the PATH class/consult chooser was removed — STARTFLOW.2).
// INIT opens straight on the class Day screen. The catch-all is LOAD-BEARING during
// the deploy→republish interim: until the Meta template button + Flow JSON are
// republished, a tap still opens the old PATH screen, whose Continue posts screen
// 'PATH' here → funnelled to the class Day screen (a class pick works; a consult
// pick is silently treated as class, which is the intended end state anyway). The
// path==='consult' branches below likewise serve any in-flight session whose screen
// data still holds path:'consult' when this deploys. Consult is otherwise offered
// conversationally by Mia after the Flow completes a class booking.
async function classDayScreen(db, locationId) {
  const classes = await listPublicClasses(db, locationId)
  const seen = new Map()
  for (const c of classes) {
    // TZ.17 — `c.day` is the class's day on the studio's own calendar
    // (public-classes, TZ.7). `starts_at.slice(0, 10)` was its UTC day, which
    // put a 00:30 Dublin summer class under the previous day.
    const day = flowClassDay(c)
    if (!seen.has(day)) seen.set(day, { id: day, title: dayLabel(day) })
  }
  return dayScreen([...seen.values()], 'class')
}

export async function handleDataExchange(db, { decryptedBody, contact, locationId, config }) {
  const { action, screen, data = {} } = decryptedBody
  if (action === 'ping') return PING
  if (action === 'INIT') return classDayScreen(db, locationId)

  if (screen === SCREEN.DAY) {
    const path = data.path
    if (path === 'consult') {
      const event = await resolveConsultEvent(db, locationId, config)
      const slots = await computeAvailableSlots(db, event, data.day)
      return slotScreen({ day: data.day, path, slots: slots.map((s) => ({ id: `${event.id}|${data.day}|${s.start}|${s.end}`, title: s.start })) })
    }
    const classes = (await listPublicClasses(db, locationId)).filter((c) => flowClassDay(c) === data.day)
    const zone = await flowZone(db, locationId)
    // Capacity / spaces-left is deliberately NOT shown to customers — matches the
    // /start class-picker decision (PR #710: "removed the X-left badge"). Time + name only.
    return slotScreen({ day: data.day, path, slots: classes.map((c) => ({ id: `${c.event_id}|${c.starts_at}|${c.name}`, title: `${timeLabel(c.starts_at, zone)} ${c.name}` })) })
  }

  if (screen === SCREEN.SLOT) {
    const terms = data.path === 'consult' ? { required: false } : await flowTermsFor(db, locationId)
    return detailsScreen({ name: contact?.name, email: contact?.email }, { path: data.path, slot: data.slot }, terms)
  }

  if (screen === SCREEN.DETAILS) {
    const accepted = asBool(data.terms_accepted)
    // Only the new Flow posts terms_accepted at all. The Flow published before
    // UN1TWRITE.19 has no OptIn, so asking there would refresh DETAILS forever:
    // it goes through with no acceptance instead (no account is created
    // without one; an existing account books as normal).
    const flowHasOptIn = Object.hasOwn(data, 'terms_accepted')
    if (data.path !== 'consult' && flowHasOptIn && !accepted) {
      // UN1TWRITE.19 — the tick is required at a un1t.online funnel studio:
      // DETAILS again, with what they typed and the operator's message.
      const terms = await flowTermsFor(db, locationId)
      if (terms.required) {
        return detailsScreen(
          { name: data.name, email: data.email, marketing_opt_in: asBool(data.marketing_opt_in) },
          { path: data.path, slot: data.slot },
          { ...terms, accepted: false, error: terms.message },
        )
      }
    }
    const summary = data.path === 'consult' ? 'Confirm your consultation' : 'Confirm your class'
    const selection = { path: data.path, slot: data.slot, name: data.name, email: data.email, marketing_opt_in: data.marketing_opt_in }
    if (flowHasOptIn) selection.terms_accepted = accepted
    return confirmScreen(summary, selection)
  }

  return classDayScreen(db, locationId)
}

export function parseFlowCompletion(interactive) {
  if (interactive?.type !== 'nfm_reply') return null
  let payload
  try { payload = JSON.parse(interactive.nfm_reply?.response_json || '{}') } catch { return null }
  if (!payload.path) return null
  const { path, name, email, marketing_opt_in, terms_accepted, ...selection } = payload
  return { path, selection, contactFields: { name, email, marketing_opt_in: asBool(marketing_opt_in), terms_accepted: asBool(terms_accepted) } }
}
