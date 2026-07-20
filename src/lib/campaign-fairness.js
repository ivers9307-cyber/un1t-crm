// SAAS4-O3 — tenant fairness for the run-campaigns pick (SaaS
// machinery plan §4). The old pick was a global oldest-first FIFO
// with 3 slots per tick: one busy tenant queuing several campaigns
// occupied every slot and starved everyone else's sends.
//
// pickFairCampaigns is round-robin by location over an age-ordered
// window: every location with queued work gets one slot before any
// location gets a second; leftover slots fill by age. A single-tenant
// queue still gets full throughput (fairness never idles a slot).

/**
 * @param {Array<{location_id: string}>} rows - candidates, OLDEST FIRST
 *   (the caller's `.order('updated_at')` — input order is age order)
 * @param {number} max - slots this tick
 */
export function pickFairCampaigns(rows, max) {
  const queues = new Map() // location_id → rows, oldest first
  for (const row of rows || []) {
    const q = queues.get(row.location_id) || []
    q.push(row)
    queues.set(row.location_id, q)
  }

  const picked = []
  // Locations iterate in first-seen (= oldest-campaign) order; each
  // pass takes one per location until slots or work run out.
  while (picked.length < max) {
    let tookAny = false
    for (const q of queues.values()) {
      if (picked.length >= max) break
      const next = q.shift()
      if (next) {
        picked.push(next)
        tookAny = true
      }
    }
    if (!tookAny) break
  }
  return picked
}
