// Pure patch builders for the inbox follow-up state columns (INBOXFOLLOW.1).
// Each returns an object to spread into an existing conversation update.
// Reading these columns lives in shared/inbox-queues.js.

const SNOOZE_CLEARED = { snoozed_until: null, snoozed_by: null, snooze_note: null }

// A customer message arrived: they are waiting, staff are no longer.
export function inboundPatch(existing, nowIso) {
  return {
    customer_waiting_since: existing?.customer_waiting_since || nowIso,
    staff_waiting_since: null,
    staff_nudged_at: null,
    staff_nudge_outcome: null,
    ...SNOOZE_CLEARED,
  }
}

// A coach replied from the thread: they own it until someone completes it.
export function staffReplyPatch(existing, nowIso) {
  return {
    staff_owned_since: existing?.staff_owned_since || nowIso,
    staff_waiting_since: nowIso,
    customer_waiting_since: null,
    staff_nudged_at: null,
    staff_nudge_outcome: null,
    handoff_requested_at: null,
    ...SNOOZE_CLEARED,
  }
}

// Mia answered: the customer is no longer waiting. Touches nothing else.
export function agentReplyPatch() {
  return { customer_waiting_since: null }
}

export function handoffRequestPatch(nowIso) {
  return { handoff_requested_at: nowIso }
}

export function completePatch() {
  return {
    customer_waiting_since: null,
    staff_owned_since: null,
    staff_waiting_since: null,
    staff_nudged_at: null,
    staff_nudge_outcome: null,
    handoff_requested_at: null,
    ...SNOOZE_CLEARED,
  }
}

export function handBackPatch() {
  return { ...completePatch(), agent_active: true, agent_handed_off_at: null, handoff_escalated_at: null }
}

export function snoozePatch({ untilIso, userId, note }) {
  return { snoozed_until: untilIso, snoozed_by: userId, snooze_note: note ?? null }
}

export function unsnoozePatch() {
  return { ...SNOOZE_CLEARED }
}
