// HOSTSTATS.1 — the server side of event attribution: sanitise, then prove
// the host-campaign id. `hc` is client-supplied, so a uuid of the right shape
// is not evidence: it is kept only when it names a campaign of the event's
// own host (a foreign or made-up id, an event with no host, or a failed read
// all drop it, and `source` falls through to the utm/referrer/direct rule).
// Splitting this from event-attribution.js keeps that module import-safe for
// the browser (no db).

import { sanitiseEventAttribution, sourceOf } from '@/lib/event-attribution'

const bareHost = (h) => String(h || '').trim().toLowerCase().replace(/^www\./, '')

/**
 * @param db service-role client
 * @param input the client's raw attribution (or null/undefined)
 * @param race `{ host_id }` of the event the request names
 * @param opts `{ requestHost }`: the host the request arrived on. A referrer
 *   on that same host is our own page (the series page, the host page) —
 *   a hop inside the visit, not where the visitor came from — so it is
 *   dropped and the source falls through (the tab's first touch still
 *   carries any utm/hc it arrived with).
 * @returns the sanitised attribution with a proven host_campaign_id, or null
 */
export async function resolveEventAttribution(db, input, race, { requestHost = null } = {}) {
  let a = sanitiseEventAttribution(input)
  if (!a) return null
  if (a.referrer_host && requestHost && bareHost(a.referrer_host) === bareHost(requestHost)) {
    a = { ...a, referrer_host: null }
    a.source = sourceOf(a)
  }
  if (!a.host_campaign_id) return a
  let proven = false
  if (race?.host_id) {
    const { data, error } = await db
      .from('host_campaigns')
      .select('id')
      .eq('id', a.host_campaign_id)
      .eq('host_id', race.host_id)
      .maybeSingle()
    proven = !error && !!data
  }
  if (proven) return a
  const out = { ...a, host_campaign_id: null }
  out.source = sourceOf(out)
  return out
}
