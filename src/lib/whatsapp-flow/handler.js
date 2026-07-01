// Orchestrates the Flow data-exchange: prefill on INIT, resolve live days/slots
// on each step, and parse the completion payload. All I/O lives here.
import { computeAvailableDays, computeAvailableSlots } from '@/lib/booking-slots.js'
import { listPublicClasses } from '@/lib/public-classes.js'
import { SCREEN, pathScreen, dayScreen, slotScreen, detailsScreen, confirmScreen } from './screens.js'

const PING = { data: { status: 'active' } }

async function resolveConsultEvent(db, locationId, config) {
  const { data: event } = await db.from('event_types')
    .select('id, name, slug, duration_minutes, buffer_minutes, availability, max_advance_days, location_id')
    .eq('location_id', locationId).eq('slug', config.consult_event_slug).eq('active', true).maybeSingle()
  return event
}

function classDaysFrom(classes) {
  const seen = new Map()
  for (const c of classes) {
    const day = c.starts_at.slice(0, 10)
    if (!seen.has(day)) seen.set(day, { id: day, title: dayLabel(day) })
  }
  return [...seen.values()]
}
function dayLabel(iso) {
  return new Intl.DateTimeFormat('en-IE', { timeZone: 'Europe/Dublin', weekday: 'short', day: 'numeric', month: 'short' })
    .format(new Date(`${iso}T12:00:00Z`))
}
function timeLabel(iso) {
  return new Intl.DateTimeFormat('en-IE', { timeZone: 'Europe/Dublin', hour: '2-digit', minute: '2-digit' }).format(new Date(iso))
}

export async function handleDataExchange(db, { decryptedBody, contact, locationId, config }) {
  const { action, screen, data = {} } = decryptedBody
  if (action === 'ping') return PING
  if (action === 'INIT') return pathScreen()

  if (screen === SCREEN.PATH) {
    if (data.path === 'consult') {
      const event = await resolveConsultEvent(db, locationId, config)
      const days = await computeAvailableDays(db, event, { days: 14 })
      return dayScreen(days)
    }
    const classes = await listPublicClasses(db, locationId)
    return dayScreen(classDaysFrom(classes))
  }

  if (screen === SCREEN.DAY) {
    if (data.path === 'consult') {
      const event = await resolveConsultEvent(db, locationId, config)
      const slots = await computeAvailableSlots(db, event, data.day)
      return slotScreen({ day: data.day, slots: slots.map((s) => ({ id: `${event.id}|${data.day}|${s.start}|${s.end}`, title: `${s.start}` })) })
    }
    const classes = (await listPublicClasses(db, locationId)).filter((c) => c.starts_at.slice(0, 10) === data.day)
    return slotScreen({ day: data.day, slots: classes.map((c) => ({ id: c.event_id, title: `${timeLabel(c.starts_at)} ${c.name}${c.spots_left != null ? ` (${c.spots_left} left)` : ''}` })) })
  }

  if (screen === SCREEN.SLOT) {
    return detailsScreen({ name: contact?.name, email: contact?.email })
  }

  if (screen === SCREEN.DETAILS) {
    const summary = data.path === 'consult' ? 'Confirm your consultation' : 'Confirm your class'
    return confirmScreen({ summary, path: data.path, ...data })
  }

  return pathScreen()
}

export function parseFlowCompletion(interactive) {
  if (interactive?.type !== 'nfm_reply') return null
  let payload
  try { payload = JSON.parse(interactive.nfm_reply?.response_json || '{}') } catch { return null }
  if (!payload.path) return null
  const { path, name, email, marketing_opt_in, ...selection } = payload
  return { path, selection, contactFields: { name, email, marketing_opt_in: marketing_opt_in === true || marketing_opt_in === 'true' } }
}
