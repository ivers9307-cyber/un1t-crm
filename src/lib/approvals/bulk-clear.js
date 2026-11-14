// APPROVALSQ.2 — rules for clearing several Mia requests at once on /approvals.
// Pure: no DB, no fetch. The page supplies `clearOne`, which sends the same
// quiet clear PATCH a single card sends.

import { BOOKING_KINDS } from '@shared/approvals-next-steps'

// Only Mia requests (waiting or failed) can be cleared quietly. Paid trials,
// corporate promos and offer sales never can.
export function isBulkClearable(item) {
  return item?.providerKey === 'agent_requests'
}

// How many of these are waiting (not failed) class bookings or consultations,
// the ones where Mia told the customer the team would confirm.
export function bookingWarningCount(items) {
  return (Array.isArray(items) ? items : [])
    .filter((i) => !i?.failed && (BOOKING_KINDS.has(i?.kind) || i?.kind === 'consultation'))
    .length
}

// One request at a time, never in parallel, never stopping early. `clearOne`
// resolves `{ ok: true }` for a cleared request; anything else, a throw
// included, is a failure. `entries` are whatever the caller sends on (an id, or
// since APPROVALSQ.6 the item itself, so each request can carry its own studio);
// the result lists hand the same entries back.
export async function runBulkClear(entries, { note, clearOne }) {
  const cleared = []
  const failed = []
  for (const id of entries) {
    let ok = false
    try {
      const res = await clearOne(id, note)
      ok = res?.ok === true
    } catch {
      ok = false
    }
    ;(ok ? cleared : failed).push(id)
  }
  return { cleared, failed }
}

// APPROVALSQ.5 — undo a bulk clear: the same walk, one request at a time, never
// in parallel, never stopping early. `undoOne` resolves `{ ok: true }` for a
// restored request; anything else, a throw included, is a failure.
export async function runBulkUndo(entries, { undoOne }) {
  const restored = []
  const failed = []
  for (const id of entries) {
    let ok = false
    try {
      const res = await undoOne(id)
      ok = res?.ok === true
    } catch {
      ok = false
    }
    ;(ok ? restored : failed).push(id)
  }
  return { restored, failed }
}
