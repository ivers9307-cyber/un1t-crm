// INBOXFOLLOW.1 — what a queue row says about time: how long the customer has
// waited on us (or we on them), when the WhatsApp reply window closes, and why
// a thread is where it is. Presentational only: the rules are in
// shared/inbox-queues.js, the caller passes the clock (`nowMs`), the studio's
// follow-up config (`cfg`) and the studio's zone for clock times.

import {
  channelKeyOf, needsReply, waitSinceMs, windowState, isSnoozed, returnReason,
} from '@/lib/inbox-queues'
import { formatInZone, resolveZone } from '@/lib/location-time'

const MIN_MS = 60_000
const HOUR_MS = 3600_000
const DAY_MS = 24 * HOUR_MS

const CHIP = 'inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium'

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

// "waiting 2h 10m" when it is our turn; "quiet 2 days" when it is the customer's.
export function WaitChip({ conv, nowMs, cfg }) {
  if (!conv || conv.resolved_at) return null
  const ch = channelKeyOf(conv)
  if (needsReply(conv, nowMs, cfg, ch)) {
    const since = waitSinceMs(conv, nowMs, cfg, ch)
    if (since === null) return null
    return <span data-testid="wait-chip" className={`${CHIP} bg-amber-500/10 text-amber-700`}>waiting {durationLabel(nowMs - since)}</span>
  }
  const quietSince = conv.staff_waiting_since ? new Date(conv.staff_waiting_since).getTime() : null
  if (quietSince === null || !Number.isFinite(quietSince)) return null
  return <span data-testid="wait-chip" className={`${CHIP} bg-slate-500/10 text-slate-700`}>quiet {durationLabel(nowMs - quietSince)}</span>
}

// "closes in 3h" (amber when it closes soon) or "template only". WhatsApp only.
export function WindowChip({ conv, nowMs }) {
  const state = windowState(conv, nowMs, channelKeyOf(conv))
  if (!state) return null
  if (state.kind === 'closed') {
    return <span data-testid="window-chip" className={`${CHIP} bg-gray-500/10 text-gray-700`}>template only</span>
  }
  const tone = state.soon ? 'bg-amber-500/10 text-amber-700' : 'bg-emerald-500/10 text-emerald-700'
  const left = state.msLeft >= HOUR_MS ? `${Math.floor(state.msLeft / HOUR_MS)}h` : `${Math.max(1, Math.floor(state.msLeft / MIN_MS))}m`
  return <span data-testid="window-chip" className={`${CHIP} ${tone}`}>closes in {left}</span>
}

// "Fri 09:00" in the studio's zone.
function dayTime(ms, zone) {
  const z = resolveZone(zone)
  return `${formatInZone(ms, z, { weekday: 'short' })} ${formatInZone(ms, z, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}`
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
  if (conv.staff_waiting_since && (conv.staff_nudge_outcome === 'sent' || conv.staff_nudge_outcome === 'sending') && conv.staff_nudged_at) {
    return `Mia nudged ${dayTime(new Date(conv.staff_nudged_at).getTime(), zone)}`
  }
  return null
}

export function StateLine({ conv, nowMs, cfg, zone }) {
  const text = stateLineText({ conv, nowMs, cfg, zone })
  if (!text) return null
  return <span data-testid="state-line" className="text-xs text-un1t-muted truncate">{text}</span>
}
