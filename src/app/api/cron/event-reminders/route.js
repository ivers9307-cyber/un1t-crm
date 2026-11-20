// EVENTS-REMINDERS.1 — daily pre-event reminder cron (mig 384).
//
// Sends every CONFIRMED registrant of an event happening in exactly 3 days or
// exactly 1 day a reminder (email + best-effort push) carrying their check-in
// QR + the event time/location. Reminders are TRANSACTIONAL (the person
// booked) — not gated on marketing consent — but the hard administrative
// opt-out is respected. Idempotent via event_reminder_sends
// UNIQUE(registration_id, reminder_offset).
//
// TZ.6 — the schedule is hourly; each event's location acts at its daily slot:
// 09:00 UTC for a Europe/Dublin studio (as before), 09:00 local for any other
// zone, at most once per local day (src/lib/cron-daily-slot.js). TZ.9 — "3
// days" and "1 day" count from each event's own studio day (Dublin events: the
// same day as before).
//
// defineCron owns the CRON_SECRET check, the error boundary and every stamp.
// The 'event-reminders' row is stamped on a slot tick whose gate did not fault;
// a quiet tick answers success with `stamp: false` (the row keeps its daily
// clock); a faulted gate answers 500 unstamped. The rating-request arm's row
// rides in `arms`, listed only when its own slot tick was clean, so it is
// stamped whatever the parent did. Its failure is a fixed `error` field in the
// response; the detail is logged.
import { defineCron } from '@/lib/define-cron'
import { runEventReminders } from '@/lib/event-attendee-reminders'
import { gateDailySlot, slotFor, slotTickStampable } from '@/lib/cron-daily-slot'
import { runRatingRequests } from '@/lib/event-rating-requests'
import { EVENT_RATING_REQUESTS_HEARTBEAT, ratingRequestsArmHealthy } from '@/lib/cron-arm-health'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export const GET = defineCron({ heartbeat: 'event-reminders' }, async ({ db }) => {
  const nowMs = Date.now()
  const gate = await gateDailySlot(db, 'event-reminders', { nowMs, module: 'event-reminders' })
  if (!gate.ok) return { ok: false, body: { error: 'locations unreadable', slot: gate.summary } }

  // HOSTPAGE.2 — the rating-request arm: its own slot claim (same hour, its
  // own key) and its own heartbeat row, stamped only on a clean outcome. It
  // runs BEFORE the parent's quiet-tick return so its gate decides on its
  // own (a parent slot already taken, or a faulted parent claim, never
  // silences the arm). Its result rides in the response and never decides
  // this cron's stamp or status (a thrown arm is a field; its own row goes
  // stale).
  const { result: ratingRequests, arm } = await runRatingRequestsArm(db, nowMs)
  const arms = arm ? [arm] : []

  if (gate.slots.size === 0) {
    // A quiet tick (no slot taken) never stamps, so the row keeps the legacy
    // clock; a faulted one (a claim write failed) answers 500 and the slot pages.
    return {
      ok: !gate.faulted,
      stamp: false,
      arms,
      body: { data: { events: 0, sent: 0, skipped: 0, rating_requests: ratingRequests, slot: gate.summary } },
    }
  }

  // The arm was already stamped before this step under the hand-written
  // handler, so a throw here still lists it (a 500 with a fixed error).
  let data
  try {
    data = await runEventReminders({ db, nowMs, isDue: (locationId) => !!slotFor(gate.slots, locationId) })
  } catch (err) {
    logError('event-reminders', 'reminders run threw', { err })
    return { ok: false, arms, body: { error: 'Event reminders failed' } }
  }

  // A slot tick stamps (slotTickStampable) unless the gate faulted, which
  // answers 500 unstamped.
  return {
    ok: slotTickStampable(gate),
    outcome: { ...data, slot: gate.summary },
    arms,
    body: { data: { ...data, rating_requests: ratingRequests, slot: gate.summary } },
  }
})

async function runRatingRequestsArm(db, nowMs) {
  try {
    const armGate = await gateDailySlot(db, 'event-rating-requests', { nowMs, module: 'event-reminders' })
    if (!armGate.ok || armGate.slots.size === 0) return { result: { ok: !armGate.faulted, slot: armGate.summary }, arm: null }
    const outcome = await runRatingRequests({ db, nowMs, isDue: (locationId) => !!slotFor(armGate.slots, locationId) })
    const arm = slotTickStampable(armGate) && ratingRequestsArmHealthy(outcome)
      ? { heartbeat: EVENT_RATING_REQUESTS_HEARTBEAT, outcome: { ...outcome, slot: armGate.summary } }
      : null
    return { result: { ok: true, ...outcome, slot: armGate.summary }, arm }
  } catch (err) {
    logError('event-rating-requests', 'arm threw', { err })
    return { result: { ok: false, error: 'Rating requests failed' }, arm: null }
  }
}
