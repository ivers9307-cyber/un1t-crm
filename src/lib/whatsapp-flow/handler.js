// Orchestrates the Flow data-exchange: prefill on INIT, resolve live days/slots
// on each step, thread state (path/slot) forward, and parse the completion.
// The chosen slot id encodes everything the booking needs (decoded at completion):
//   class:   `${event_id}|${starts_at}|${class_name}`
//   consult: `${event_id}|${date}|${start}|${end}`
import { computeAvailableSlots } from '@/lib/booking-slots.js'
import { listPublicClasses } from '@/lib/public-classes.js'
import { SCREEN, dayScreen, slotScreen, detailsScreen, confirmScreen } from './screens.js'
import { formatInZone, getLocationZone, LocationZoneReadError, DEFAULT_TZ } from '@/lib/location-time'
import { logWarn } from '@/lib/log'

const PING = { data: { status: 'active' } }

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
    const day = c.starts_at.slice(0, 10)
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
    const classes = (await listPublicClasses(db, locationId)).filter((c) => c.starts_at.slice(0, 10) === data.day)
    const zone = await flowZone(db, locationId)
    // Capacity / spaces-left is deliberately NOT shown to customers — matches the
    // /start class-picker decision (PR #710: "removed the X-left badge"). Time + name only.
    return slotScreen({ day: data.day, path, slots: classes.map((c) => ({ id: `${c.event_id}|${c.starts_at}|${c.name}`, title: `${timeLabel(c.starts_at, zone)} ${c.name}` })) })
  }

  if (screen === SCREEN.SLOT) {
    return detailsScreen({ name: contact?.name, email: contact?.email }, { path: data.path, slot: data.slot })
  }

  if (screen === SCREEN.DETAILS) {
    const summary = data.path === 'consult' ? 'Confirm your consultation' : 'Confirm your class'
    const selection = { path: data.path, slot: data.slot, name: data.name, email: data.email, marketing_opt_in: data.marketing_opt_in }
    return confirmScreen(summary, selection)
  }

  return classDayScreen(db, locationId)
}

export function parseFlowCompletion(interactive) {
  if (interactive?.type !== 'nfm_reply') return null
  let payload
  try { payload = JSON.parse(interactive.nfm_reply?.response_json || '{}') } catch { return null }
  if (!payload.path) return null
  const { path, name, email, marketing_opt_in, ...selection } = payload
  return { path, selection, contactFields: { name, email, marketing_opt_in: marketing_opt_in === true || marketing_opt_in === 'true' } }
}
