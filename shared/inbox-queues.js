// Inbox queue rules: the ONE module the web inbox, the badge counts and the
// phone all read. Pure: takes the conversation row, the current time and a
// studio's follow-up config; no I/O, no React. Imported as
// '@shared/inbox-queues' from src/ and 'shared/inbox-queues' from mobile/.
//
// Row columns read: resolved_at, last_message_at, last_message_direction,
// window_expires_at / agent_paused_at (WhatsApp only), agent_active,
// pending_approval (a route-annotated flag, not a column), and the
// INBOXFOLLOW.1 columns customer_waiting_since, staff_owned_since,
// staff_waiting_since, staff_nudged_at, staff_nudge_outcome,
// handoff_requested_at, snoozed_until.
//
// Defaults (nowMs = Date.now(), cfg = DEFAULT_FOLLOWUP_CFG, channel = 'wa')
// keep one-argument callers working until they pass real values.

const H_MS = 3600_000

export const DEFAULT_FOLLOWUP_CFG = { quietHours: 48, nudgeEnabled: false }
export const NUDGE_GRACE_HOURS = 24

export const QUEUES = [
  { key: 'needs_reply', label: 'Needs reply' },
  { key: 'mia_help', label: 'Mia needs help' },
  { key: 'waiting', label: 'Waiting' },
  { key: 'pending_approval', label: 'Approvals' },
  { key: 'all', label: 'All' },
]

function ms(iso) {
  if (!iso) return null
  const t = typeof iso === 'number' ? iso : new Date(iso).getTime()
  return Number.isFinite(t) ? t : null
}

// The merged web inbox tags rows `_ch` ('wa' | 'ig') (shared/channels.js);
// phone rows carry `channel: 'instagram'`. Anything else is WhatsApp.
export function channelKeyOf(c) {
  if (c?._ch === 'ig' || c?._ch === 'wa') return c._ch
  return c?.channel === 'instagram' ? 'ig' : 'wa'
}

export function isSnoozed(c, nowMs = Date.now()) {
  const t = ms(c?.snoozed_until)
  return t !== null && t > nowMs
}

// A snooze whose time has come. The columns are only cleared by a person
// acting or the customer writing, so an ended snooze stays on the row.
export function snoozeEnded(c, nowMs = Date.now()) {
  const t = ms(c?.snoozed_until)
  return t !== null && nowMs >= t
}

// A reminder that fired: the snooze ended on an unresolved thread that is not
// on the ladder (no staff_waiting_since) and not a Mia hand-off. Ladder threads
// keep returnAtMs; hand-offs go back to Mia needs help.
function snoozeReminder(c, nowMs) {
  return !!c && !c.resolved_at && snoozeEnded(c, nowMs)
    && ms(c.staff_waiting_since) === null && !c.handoff_requested_at
}

// When a thread we are waiting on comes back, or null when we are not waiting.
export function returnAtMs(c, cfg = DEFAULT_FOLLOWUP_CFG, channel = 'wa') {
  const since = ms(c?.staff_waiting_since)
  if (since === null) return null
  const q = cfg.quietHours * H_MS
  const nudged = ms(c?.staff_nudged_at)
  const outcome = c?.staff_nudge_outcome
  let at
  if ((outcome === 'sent' || outcome === 'sending') && nudged !== null) at = nudged + q
  else if (typeof outcome === 'string' && outcome.startsWith('skipped') && nudged !== null) at = nudged
  else if (!outcome && cfg.nudgeEnabled && channel === 'wa') at = since + q + NUDGE_GRACE_HOURS * H_MS
  else at = since + q
  const snooze = ms(c?.snoozed_until)
  return snooze !== null && snooze > at ? snooze : at
}

function hasReturned(c, nowMs, cfg, channel) {
  const at = returnAtMs(c, cfg, channel)
  return at !== null && nowMs >= at
}

export function returnReason(c, nowMs = Date.now(), cfg = DEFAULT_FOLLOWUP_CFG, channel = 'wa') {
  if (c?.resolved_at) return null
  if (!hasReturned(c, nowMs, cfg, channel)) {
    return c?.last_message_direction !== 'inbound' && snoozeReminder(c, nowMs) ? 'snooze_ended' : null
  }
  const outcome = c.staff_nudge_outcome
  return outcome === 'sent' || outcome === 'sending' ? 'no_reply_after_nudge' : 'gone_quiet'
}

export function needsReply(c, nowMs = Date.now(), cfg = DEFAULT_FOLLOWUP_CFG, channel = 'wa') {
  if (!c || c.resolved_at || isSnoozed(c, nowMs)) return false
  return c.last_message_direction === 'inbound' || hasReturned(c, nowMs, cfg, channel) || snoozeReminder(c, nowMs)
}

// A snoozed hand-off waits with the rest of the snoozed threads (Waiting), so
// the chip count and the badge agree; it is back when the snooze ends.
export function needsMiaHelp(c, nowMs = Date.now()) {
  return !!c && !c.resolved_at && !!c.handoff_requested_at && !isSnoozed(c, nowMs)
}

export function isWaiting(c, nowMs = Date.now(), cfg = DEFAULT_FOLLOWUP_CFG, channel = 'wa') {
  if (!c || c.resolved_at) return false
  if (isSnoozed(c, nowMs)) return true
  // Belt and braces: a customer message the coach has not answered is Needs
  // reply, whatever stale staff_waiting_since says.
  if (c.last_message_direction === 'inbound') return false
  return ms(c.staff_waiting_since) !== null && !hasReturned(c, nowMs, cfg, channel)
}

export function hasPendingApproval(c) {
  return !!c?.pending_approval
}

// last_message_at guard: empty conversation shells never inflate a badge.
export function needsAction(c, nowMs = Date.now(), cfg = DEFAULT_FOLLOWUP_CFG, channel = 'wa') {
  if (!c || c.resolved_at || !c.last_message_at || isSnoozed(c, nowMs)) return false
  return needsReply(c, nowMs, cfg, channel) || needsMiaHelp(c, nowMs)
}

export function waitSinceMs(c, nowMs = Date.now(), cfg = DEFAULT_FOLLOWUP_CFG, channel = 'wa') {
  if (!c) return null
  if (c.last_message_direction === 'inbound') return ms(c.customer_waiting_since)
  if (hasReturned(c, nowMs, cfg, channel)) return returnAtMs(c, cfg, channel)
  return snoozeReminder(c, nowMs) ? ms(c.snoozed_until) : null
}

// Oldest wait first; rows with no wait time come last, oldest last_message_at first.
export function sortNeedsReply(list, nowMs = Date.now(), cfg = DEFAULT_FOLLOWUP_CFG) {
  const keyed = (list || []).map(c => ({
    c,
    wait: waitSinceMs(c, nowMs, cfg, channelKeyOf(c)),
    last: ms(c.last_message_at) ?? 0,
  }))
  keyed.sort((a, b) => {
    if (a.wait !== null && b.wait !== null) return a.wait - b.wait
    if (a.wait !== null) return -1
    if (b.wait !== null) return 1
    return a.last - b.last
  })
  return keyed.map(k => k.c)
}

export function windowState(c, nowMs = Date.now(), channel = 'wa') {
  if (channel !== 'wa') return null
  const exp = ms(c?.window_expires_at)
  if (exp === null || exp <= nowMs) return { kind: 'closed' }
  const msLeft = exp - nowMs
  return { kind: 'open', msLeft, soon: msLeft < 4 * H_MS }
}

export function handledBy(c, channel = 'wa') {
  if (channel === 'wa' && c?.agent_paused_at) return 'paused'
  if (c?.handoff_requested_at && !c?.staff_owned_since) return 'unclaimed'
  if (c?.staff_owned_since || c?.agent_active === false) return 'person'
  return 'mia'
}

function predicateFor(queue, nowMs, cfg) {
  const ch = c => channelKeyOf(c)
  switch (queue) {
    case 'needs_reply': return c => needsReply(c, nowMs, cfg, ch(c))
    case 'mia_help': return c => needsMiaHelp(c, nowMs)
    case 'waiting': return c => isWaiting(c, nowMs, cfg, ch(c))
    case 'pending_approval': return hasPendingApproval
    default: return () => true
  }
}

export function filterByQueue(list, queue, nowMs = Date.now(), cfg = DEFAULT_FOLLOWUP_CFG) {
  return (list || []).filter(predicateFor(queue, nowMs, cfg))
}

export function queueCounts(list, nowMs = Date.now(), cfg = DEFAULT_FOLLOWUP_CFG) {
  const out = {}
  for (const q of QUEUES) out[q.key] = filterByQueue(list, q.key, nowMs, cfg).length
  return out
}
