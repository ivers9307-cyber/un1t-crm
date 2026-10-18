// UN1TWRITE.17 — a un1t.online studio's terms and conditions and liability
// waiver, read with the studio's own token (spec D 6.5).
//
// The snapshot marks GET /studios/{id}/legal/terms-and-conditions and
// /legal/liability-waiver bearer-secured, so a browser cannot fetch them: the
// public page /legal/un1t/[slug]/[doc] renders what this reads. Reads, so the
// writes switch does not gate them, but they go through the writer's read
// client and so take a slot of the studio's write budget like every other
// request the write side makes.
//
// A PUBLIC page drives these reads, so a stranger refreshing it must never be
// able to spend the studio's write budget or hold a request open:
//   - each document is cached on its own: an hour when it read, a minute when
//     it failed (a studio with no waiver published costs one slot a minute
//     per instance, not one per view);
//   - one read per location is in flight at a time; concurrent views share it;
//   - one attempt per document: no retry, no rate-limit wait (the writer's
//     sleep refuses), and a 4 s timeout on each request;
//   - the cache is keyed by location AND the token's studio, so repointing
//     the token never serves the old studio's text.
//
// Never throws. `version` is what a request's terms_version records: each
// document's updated_at, or a short hash of its text when it carries none (a
// non-string updated_at counts as none); null unless both documents read.

import { createHash } from 'node:crypto'
import { createUn1tWriter } from './un1t-online-write.js'
import { logWarn } from './log'

export const UN1T_LEGAL_TTL_MS = 60 * 60_000
export const UN1T_LEGAL_FAILURE_TTL_MS = 60_000
export const UN1T_LEGAL_TIMEOUT_MS = 4_000
import { legalDocPathFor } from './un1t-online-funnel-copy.js'
export { legalDocPathFor }

const DOCS = Object.freeze({
  terms: 'terms-and-conditions',
  waiver: 'liability-waiver',
})

const cache = new Map() // `${locationId}:${studioId}:${doc}` → { atMs, doc }
const inFlight = new Map() // locationId → Promise

/** Test seam only: the cache is module state. */
export function _resetUn1tLegalCacheForTests() {
  cache.clear()
  inFlight.clear()
}

const empty = () => ({ terms: null, waiver: null, version: null })


// The DTO is not pinned by the snapshot beyond "a document": accept
// { content | text | body, updated_at | updatedAt } or a bare string.
function shapeDoc(data) {
  const raw = typeof data === 'string' ? data : (data && typeof data === 'object' ? (data.content ?? data.text ?? data.body) : null)
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const at = data && typeof data === 'object' ? (data.updated_at ?? data.updatedAt ?? null) : null
  return { content: raw, updatedAt: typeof at === 'string' && at.trim() ? at.trim() : null }
}

const stamp = (doc) => doc.updatedAt ?? `sha256-${createHash('sha256').update(doc.content).digest('hex').slice(0, 12)}`
const copyOf = (doc) => (doc ? { ...doc } : null)

// One attempt, bounded in time; no waits.
const noWait = async () => {
  throw Object.assign(new Error('un1t.online legal read does not wait'), { code: 'no_wait' })
}
// A 429 or 5xx becomes a thrown fault, so the read client's retry goes
// through a backoff wait (which noWait refuses) even when the server says
// Retry-After: 0, a wait the client would otherwise skip and retry on.
const timedFetch = async (url, init = {}) => {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(UN1T_LEGAL_TIMEOUT_MS) })
  if (res.status === 429 || res.status >= 500) throw Object.assign(new Error(`un1t.online answered HTTP ${res.status}`), { status: res.status })
  return res
}

async function readOnce(db, locationId, { createWriter, now }) {
  let writer
  try {
    writer = await createWriter(db, locationId, { fetchImpl: timedFetch, sleep: noWait })
  } catch (err) {
    logWarn('un1t-online-legal', 'could not open the un1t.online reader; documents not loaded', { locationId, code: err?.code ?? err?.name ?? 'error' })
    return empty()
  }
  if (!writer?.studioId) {
    logWarn('un1t-online-legal', 'no un1t.online studio id; documents not loaded', { locationId, code: 'no_studio' })
    return empty()
  }

  const t = now()
  const out = empty()
  await Promise.all(Object.entries(DOCS).map(async ([key, slug]) => {
    const ck = `${locationId}:${writer.studioId}:${key}`
    const hit = cache.get(ck)
    const ttl = hit?.doc ? UN1T_LEGAL_TTL_MS : UN1T_LEGAL_FAILURE_TTL_MS
    if (hit && t >= hit.atMs && t - hit.atMs < ttl) {
      out[key] = copyOf(hit.doc)
      return
    }
    let doc = null
    try {
      doc = shapeDoc(await writer.read(`/studios/${encodeURIComponent(writer.studioId)}/legal/${slug}`))
      if (!doc) logWarn('un1t-online-legal', 'un1t.online sent an empty document', { locationId, code: `${key}_empty` })
    } catch (err) {
      logWarn('un1t-online-legal', 'un1t.online document read failed', { locationId, code: `${key}_unreadable`, status: err?.status ?? null })
    }
    cache.set(ck, { atMs: t, doc })
    out[key] = copyOf(doc)
  }))
  if (out.terms && out.waiver) out.version = `terms:${stamp(out.terms)}|waiver:${stamp(out.waiver)}`
  return out
}

/**
 * @returns {Promise<{ terms: {content: string, updatedAt: string|null}|null,
 *   waiver: {content: string, updatedAt: string|null}|null, version: string|null }>}
 */
export async function readUn1tLegalDocs(db, locationId, deps = {}) {
  const { createWriter = createUn1tWriter, now = () => Date.now() } = deps
  const running = inFlight.get(locationId)
  if (running) {
    const shared = await running
    return { terms: copyOf(shared.terms), waiver: copyOf(shared.waiver), version: shared.version }
  }
  const p = readOnce(db, locationId, { createWriter, now }).finally(() => inFlight.delete(locationId))
  inFlight.set(locationId, p)
  const res = await p
  return { terms: copyOf(res.terms), waiver: copyOf(res.waiver), version: res.version }
}
