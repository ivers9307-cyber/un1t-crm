// Orchestrates the Flow data-exchange: prefill on INIT, resolve live days/slots
// on each step, thread state (path/slot) forward, and parse the completion.
// The chosen slot id encodes everything the booking needs (decoded at completion):
//   class:   `${event_id}|${starts_at}|${class_name}`
//   consult: `${event_id}|${date}|${start}|${end}`
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
    const path = data.path
    if (path === 'consult') {
      const event = await resolveConsultEvent(db, locationId, config)
      const rawDays = await computeAvailableDays(db, event, { days: 14 })
      return dayScreen(rawDays.map((d) => ({ id: d.date, title: d.label })), path)
    }
    const classes = await listPublicClasses(db, locationId)
    const seen = new Map()
    for (const c of classes) {
      const day = c.starts_at.slice(0, 10)
      if (!seen.has(day)) seen.set(day, { id: day, title: dayLabel(day) })
    }
    return dayScreen([...seen.values()], path)
  }

  if (screen === SCREEN.DAY) {
    const path = data.path
    if (path === 'consult') {
      const event = await resolveConsultEvent(db, locationId, config)
      const slots = await computeAvailableSlots(db, event, data.day)
      return slotScreen({ day: data.day, path, slots: slots.map((s) => ({ id: `${event.id}|${data.day}|${s.start}|${s.end}`, title: s.start })) })
    }
    const classes = (await listPublicClasses(db, locationId)).filter((c) => c.starts_at.slice(0, 10) === data.day)
    return slotScreen({ day: data.day, path, slots: classes.map((c) => ({ id: `${c.event_id}|${c.starts_at}|${c.name}`, title: `${timeLabel(c.starts_at)} ${c.name}${c.spots_left != null ? ` (${c.spots_left} left)` : ''}` })) })
  }

  if (screen === SCREEN.SLOT) {
    return detailsScreen({ name: contact?.name, email: contact?.email }, { path: data.path, slot: data.slot })
  }

  if (screen === SCREEN.DETAILS) {
    const summary = data.path === 'consult' ? 'Confirm your consultation' : 'Confirm your class'
    const selection = { path: data.path, slot: data.slot, name: data.name, email: data.email, marketing_opt_in: data.marketing_opt_in }
    return confirmScreen(summary, selection)
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
