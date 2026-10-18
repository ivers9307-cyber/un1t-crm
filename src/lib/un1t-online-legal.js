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
// Never throws. A failed read is that document null (logged with no body
// text); the result is cached an hour per location per instance only when
// both documents read, so a blip is retried on the next view.
//
// `version` is what a request's terms_version records: each document's
// updated_at, or a short hash of its text when it carries none; null unless
// both read.

import { createHash } from 'node:crypto'
import { createUn1tWriter } from './un1t-online-write.js'
import { logWarn } from './log'

export const UN1T_LEGAL_TTL_MS = 60 * 60_000
const DOCS = Object.freeze({
  terms: 'terms-and-conditions',
  waiver: 'liability-waiver',
})

const cache = new Map() // locationId → { atMs, value }

/** Test seam only: the cache is module state. */
export function _resetUn1tLegalCacheForTests() {
  cache.clear()
}

const EMPTY = Object.freeze({ terms: null, waiver: null, version: null })

/** The public page for a studio's document. */
export function legalDocPathFor(publicPath, doc) {
  if (!Object.hasOwn(DOCS, doc)) throw new TypeError(`legalDocPathFor: unknown document '${doc}'`)
  return `/legal/un1t/${publicPath}/${doc}`
}

// The DTO is not pinned by the snapshot beyond "a document": accept
// { content | text | body, updated_at | updatedAt } or a bare string.
function shapeDoc(data) {
  const raw = typeof data === 'string' ? data : (data && typeof data === 'object' ? (data.content ?? data.text ?? data.body) : null)
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const at = data && typeof data === 'object' ? (data.updated_at ?? data.updatedAt ?? null) : null
  return { content: raw, updatedAt: typeof at === 'string' && at.trim() ? at.trim() : null }
}

const stamp = (doc) => doc.updatedAt ?? `sha256-${createHash('sha256').update(doc.content).digest('hex').slice(0, 12)}`

/**
 * @returns {Promise<{ terms: {content: string, updatedAt: string|null}|null,
 *   waiver: {content: string, updatedAt: string|null}|null, version: string|null }>}
 */
export async function readUn1tLegalDocs(db, locationId, deps = {}) {
  const { createWriter = (d, loc) => createUn1tWriter(d, loc), now = () => Date.now() } = deps
  const t = now()
  const hit = cache.get(locationId)
  if (hit && t >= hit.atMs && t - hit.atMs < UN1T_LEGAL_TTL_MS) return hit.value

  let writer
  try {
    writer = await createWriter(db, locationId)
  } catch (err) {
    logWarn('un1t-online-legal', 'could not open the un1t.online reader; documents not loaded', { locationId, code: err?.code ?? err?.name ?? 'error' })
    return EMPTY
  }
  if (!writer?.studioId) {
    logWarn('un1t-online-legal', 'no un1t.online studio id; documents not loaded', { locationId, code: 'no_studio' })
    return EMPTY
  }

  const out = { terms: null, waiver: null, version: null }
  for (const [key, slug] of Object.entries(DOCS)) {
    try {
      out[key] = shapeDoc(await writer.read(`/studios/${encodeURIComponent(writer.studioId)}/legal/${slug}`))
      if (!out[key]) logWarn('un1t-online-legal', 'un1t.online sent an empty document', { locationId, code: `${key}_empty` })
    } catch (err) {
      logWarn('un1t-online-legal', 'un1t.online document read failed', { locationId, code: `${key}_unreadable`, status: err?.status ?? null })
    }
  }
  if (out.terms && out.waiver) {
    out.version = `terms:${stamp(out.terms)}|waiver:${stamp(out.waiver)}`
    cache.set(locationId, { atMs: t, value: out })
  }
  return out
}
