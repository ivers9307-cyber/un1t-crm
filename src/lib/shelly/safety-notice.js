// SHELLYTIMERS.6 — the notices that promise a relay will "stay as it is" must
// not lie about the safety timer. A relay the schedule switched on can carry a
// device-side timer (last_applied.cap_at, SHELLYTIMERS.2) or report one
// running (last_state.timer_until, SHELLYTIMERS.4); either way it still
// switches itself off, and stopping the schedule, deleting the group or
// leaving it does not cancel that. So the notice says by when, in the
// studio's zone. Pure: no I/O, no clock.

import { timeLabelIn } from '@shared/zoned-time'

/**
 * The LATEST future instant at which any of `devices` will switch itself off,
 * or null. A cap counts only on an `on` stamp (an off never carries one);
 * either source must parse and be after `nowMs`.
 */
export function safetyTimerEndMs(devices, nowMs) {
  let end = null
  for (const d of Array.isArray(devices) ? devices : []) {
    const la = d?.last_applied && typeof d.last_applied === 'object' ? d.last_applied : null
    const cap = la?.action === 'on' && typeof la.cap_at === 'string' ? Date.parse(la.cap_at) : NaN
    const tu = typeof d?.last_state?.timer_until === 'string' ? Date.parse(d.last_state.timer_until) : NaN
    for (const t of [cap, tu]) if (Number.isFinite(t) && t > nowMs && (end === null || t > end)) end = t
  }
  return end
}

/**
 * `text`, plus one sentence naming the safety timer when one is pending:
 * "… A light the schedule switched on still switches itself off by 21:30
 * (safety timer)." `subject` lets a single device say "It". Unchanged text
 * when no timer is pending, or the time cannot be rendered.
 */
export function withSafetyTimerNotice(text, devices, nowMs, tz, subject = 'A light the schedule switched on') {
  const end = safetyTimerEndMs(devices, nowMs)
  if (end === null) return text
  const hhmm = timeLabelIn(new Date(end).toISOString(), tz)
  if (!hhmm) return text
  const base = /[.!?]$/.test(text) ? text : `${text}.`
  return `${base} ${subject} still switches itself off by ${hhmm} (safety timer).`
}
