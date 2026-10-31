// WABLASTCOUNTERS.1 — whatsapp_broadcasts.total_sent / total_failed.
//
// THE RULE: those two columns are COUNTS of whatsapp_broadcast_recipients rows,
// wherever they are written. Never a running delta.
//
// Why a module of its own: on 2026-10-31 a 342-recipient blast read
// total_sent = -1, -10, -24, -31 while it was still sending. The blast pass
// writes the two counters once, at its END, from row counts; the status
// webhook, meanwhile, answered every async refusal (Meta accepted the send,
// then failed it a second later with 131042) with `increment_…(total_sent, -1)`
// — a delta against a counter nobody had written yet. The pass's final write
// then replaced whatever the deltas had made of it, and a later refusal moved
// it again by delta. Two writers with two different models of the same column
// is how a figure goes negative with every individual write looking right.
//
// So every writer goes through here: the blast pass and the drip tick after
// their loop, the webhook on a genuine transition to 'failed'. total_delivered
// and total_read stay per-transition bumps in the webhook — nothing else
// writes them, so the delta has one owner and cannot drift the same way.
//
// A count that cannot be read is NOT zero. The old `const { count } = await …`
// then `count || 0` wrote 0 / 0 over the real figures on a timeout; here the
// caller gets `{ ok: false, error }` and writes no counter at all (the stored
// figures stay, and are re-counted on the next write).
//
// Dispatched = the message left this system and Meta accepted it. A row moves
// sent → delivered → read by status webhook, so "sent" must count all three or
// the figure SHRINKS as receipts arrive.
export const DISPATCHED_STATUSES = ['sent', 'delivered', 'read']

/**
 * Count one broadcast's dispatched and failed recipient rows.
 *
 * @returns {Promise<{ok: true, total_sent: number, total_failed: number} | {ok: false, error: object}>}
 */
export async function countBroadcastSendCounters(db, broadcastId) {
  const sentQ = await db.from('whatsapp_broadcast_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('broadcast_id', broadcastId)
    .in('status', DISPATCHED_STATUSES)
  if (sentQ.error) return { ok: false, error: sentQ.error }
  const failedQ = await db.from('whatsapp_broadcast_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('broadcast_id', broadcastId)
    .eq('status', 'failed')
  if (failedQ.error) return { ok: false, error: failedQ.error }
  return { ok: true, total_sent: sentQ.count || 0, total_failed: failedQ.count || 0 }
}

/**
 * The columns to spread into a whatsapp_broadcasts write: the two counters when
 * they were read, nothing when they were not (so the stored figures survive).
 */
export function broadcastCountersPatch(counts) {
  if (!counts?.ok) return {}
  return { total_sent: counts.total_sent, total_failed: counts.total_failed }
}

/**
 * Re-count and write the two counters for one broadcast. Used by the status
 * webhook when a dispatched row turns 'failed'. Never throws on a PostgREST
 * error (the builder resolves `{ error }`); the result says what happened.
 *
 * @returns {Promise<{ok: boolean, written: boolean, total_sent?: number, total_failed?: number, error?: object}>}
 */
export async function recountBroadcastSendCounters(db, broadcastId) {
  const counts = await countBroadcastSendCounters(db, broadcastId)
  if (!counts.ok) return { ok: false, written: false, error: counts.error }
  const { error } = await db.from('whatsapp_broadcasts')
    .update(broadcastCountersPatch(counts))
    .eq('id', broadcastId)
  if (error) return { ...counts, written: false, error }
  return { ...counts, written: true }
}

/**
 * How many recipient rows of one broadcast are still a live CLAIM: 'pending'
 * with a lease stamp. A blast pass that finishes while one exists must not go
 * terminal (see sendBroadcast): the claim belongs to a pass that died (or one
 * still running), and once the broadcast is 'sent' nothing re-opens it. A
 * row with no created_at has an unknown age and is left out: it is never
 * re-claimed either (fetchDripDoneContactIds), so holding the broadcast for
 * it would hold it for ever.
 *
 * @returns {Promise<{ok: true, count: number} | {ok: false, error: object}>}
 */
export async function countOpenClaims(db, broadcastId) {
  const { count, error } = await db.from('whatsapp_broadcast_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('broadcast_id', broadcastId)
    .eq('status', 'pending')
    .not('created_at', 'is', null)
  if (error) return { ok: false, error }
  return { ok: true, count: count || 0 }
}
