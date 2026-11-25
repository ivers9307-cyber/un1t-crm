// INBOXFOLLOW.1/.4 — what a queue row says about time: how long the customer has
// waited on us (or we on them), when the WhatsApp reply window closes, and why a
// thread is where it is. The ONE copy of the words: the web row
// (src/components/inbox/RowChips.jsx) and the phone row both render these, so
// the two surfaces cannot drift. Pure: the caller passes the clock (`nowMs`),
// the studio's follow-up config (`cfg`) and the studio's zone for clock times.
// Imported as '@shared/inbox-row-text' from src/ and 'shared/inbox-row-text'
// from mobile/. `tone` names the chip colour; each surface maps it to its own
// classes.

import {
  channelKeyOf, needsReply, waitSinceMs, windowState, isSnoozed, returnReason,
} from './inbox-queues.js'
import { formatInZone, resolveZone } from './zoned-time.js'

const MIN_MS = 60_000
const HOUR_MS = 3600_000
const DAY_MS = 24 * HOUR_MS

// "2h 10m", "45m", "3 days": the two largest units, nothing under a minute.
export function durationLabel(ms) {
  const d = Math.max(0, ms)
  if (d >= DAY_MS) {
    const days = Math.floor(d / DAY_MS)
    return `${days} ${days === 1 ? 'day' : 'days'}`
  }
  if (d >= HOUR_MS) {
    const h = Math.floor(d / HOUR_MS)
    const m = Math.floor((d % HOUR_MS) / MIN_MS)
    return m ? `${h}h ${m}m` : `${h}h`
  }
  const m = Math.floor(d / MIN_MS)
  return m >= 1 ? `${m}m` : '<1m'
}

// "waiting 2h 10m" when it is our turn (tone 'amber'); "quiet 2 days" when it is
// the customer's (tone 'slate'); null when the row shows no wait.
export function waitChipInfo(conv, nowMs, cfg) {
  if (!conv || conv.resolved_at) return null
  const ch = channelKeyOf(conv)
  if (needsReply(conv, nowMs, cfg, ch)) {
    const since = waitSinceMs(conv, nowMs, cfg, ch)
    if (since === null) return null
    return { text: `waiting ${durationLabel(nowMs - since)}`, tone: 'amber' }
  }
  const quietSince = conv.staff_waiting_since ? new Date(conv.staff_waiting_since).getTime() : null
  if (quietSince === null || !Number.isFinite(quietSince)) return null
  return { text: `quiet ${durationLabel(nowMs - quietSince)}`, tone: 'slate' }
}

// "closes in 3h" (tone 'amber' when it closes soon, else 'emerald') or
// "template only" (tone 'gray'). WhatsApp only; null for Instagram.
export function windowChipInfo(conv, nowMs) {
  const state = windowState(conv, nowMs, channelKeyOf(conv))
  if (!state) return null
  if (state.kind === 'closed') return { text: 'template only', tone: 'gray' }
  const left = state.msLeft >= HOUR_MS ? `${Math.floor(state.msLeft / HOUR_MS)}h` : `${Math.max(1, Math.floor(state.msLeft / MIN_MS))}m`
  return { text: `closes in ${left}`, tone: state.soon ? 'amber' : 'emerald' }
}

// "Fri 09:00" in the studio's zone.
export function dayTime(ms, zone) {
  const z = resolveZone(zone)
  return `${formatInZone(ms, z, { weekday: 'short' })} ${formatInZone(ms, z, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}`
}

// "Fri 27 Nov, 09:00" in the studio's zone: when a snooze ends, in a thread's
// snooze strip (web SnoozeControl and the phone's thread bar).
export function snoozeUntilLabel(iso, zone) {
  const z = resolveZone(zone)
  const ms = new Date(iso).getTime()
  return `${formatInZone(ms, z, { weekday: 'short' })} ${formatInZone(ms, z, { day: 'numeric', month: 'short' })}, ${formatInZone(ms, z, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}`
}

// The text of the line that replaces the message preview when the thread's
// state matters more than its last words; null when the preview should stay.
export function stateLineText({ conv, nowMs, cfg, zone }) {
  if (!conv || conv.resolved_at) return null
  const ch = channelKeyOf(conv)
  if (isSnoozed(conv, nowMs)) {
    const until = dayTime(new Date(conv.snoozed_until).getTime(), zone)
    const note = (conv.snooze_note || '').trim()
    return note ? `Snoozed until ${until} · ${note}` : `Snoozed until ${until}`
  }
  const reason = returnReason(conv, nowMs, cfg, ch)
  if (reason === 'no_reply_after_nudge') return 'No reply after nudge'
  if (reason === 'gone_quiet') return 'Gone quiet'
  if (reason === 'snooze_ended') {
    const note = (conv.snooze_note || '').trim()
    return note ? `Snooze ended · ${note}` : 'Snooze ended'
  }
  if (conv.staff_waiting_since && (conv.staff_nudge_outcome === 'sent' || conv.staff_nudge_outcome === 'sending') && conv.staff_nudged_at) {
    return `Mia nudged ${dayTime(new Date(conv.staff_nudged_at).getTime(), zone)}`
  }
  return null
}
