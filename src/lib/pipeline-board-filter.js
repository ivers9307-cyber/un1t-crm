// BOARDFILTER.1 — search and "stuck" on the pipeline board.
//
// The board used to offer no way to find a person: a pile of thousands was
// reachable 50 cards at a time. Both filters run in the database, on every
// column's read AND its count, so a filtered column's badge and "Load more"
// agree with what it shows, and a huge pile is searched whole.
//
// Search matches the deal title, which is the contact's name on 99% of open
// deals (9,112 of 9,181 on 16 Nov 2026). It is a deliberate substring search:
// the term is escaped (escapeLikePattern) and the wildcards are ours. A filter
// on the embedded contact would break the column counts (embedded filters
// return 0 under a head count; CLAUDE.md), which is why it reads the title.
//
// "Stuck" is exactly the card's red age footer (dealAge, src/lib/pipeline-board.js):
// 21 or more whole days in the stage, or, for a deal with no stage stamp yet,
// in the pipeline, except a deal backfilled before PIPELINE_BACKFILL_CUTOFF,
// whose import-dated age never alarms. Change the two together.
//
// Pure apart from the query builder it is handed.

import { escapeLikePattern } from '@/lib/like-escape'
import { PIPELINE_BACKFILL_CUTOFF, STALE_DAYS } from '@/lib/pipeline-board'

const DAY_MS = 86_400_000
/** Longest search term kept (longer is cut, never refused). */
export const BOARD_SEARCH_MAX = 80

/**
 * The board filter from the page's search params or the Load-more URL.
 * Unknown or empty values mean "no filter", so an old bookmark is unchanged.
 * "Stuck" applies to the Funnel view only (`view` 'dormant' drops it): the
 * off-funnel piles never alarm (their age footer stays quiet), and nearly every
 * card there is 21+ days old (8,741 of 8,863 at Stillorgan, 16 Nov 2026).
 * @param {{ get?: Function } | Record<string, unknown> | null} sp URLSearchParams or a plain object
 * @param {{ view?: string }} [opts]
 * @returns {{ q: string|null, stuck: boolean }}
 */
export function parseBoardFilter(sp, { view = 'active' } = {}) {
  const read = (k) => (typeof sp?.get === 'function' ? sp.get(k) : sp?.[k])
  const raw = read('q')
  const q = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ').slice(0, BOARD_SEARCH_MAX) : ''
  return { q: q || null, stuck: view !== 'dormant' && read('stuck') === '1' }
}

export function boardFilterActive(filter) {
  return Boolean(filter?.q) || filter?.stuck === true
}

/** The filter as URL params (only what is set), for links and the Load-more fetch. */
export function boardFilterParams(filter) {
  const p = new URLSearchParams()
  if (filter?.q) p.set('q', filter.q)
  if (filter?.stuck) p.set('stuck', '1')
  return p
}

/**
 * Add the filter to a deals query (a read or a head count). Returns the query.
 * @param {object} query a supabase-js deals builder
 * @param {{ q: string|null, stuck: boolean }} filter
 * @param {number} nowMs
 */
export function applyBoardFilter(query, filter, nowMs = Date.now()) {
  let out = query
  if (filter?.q) out = out.ilike('title', `%${escapeLikePattern(filter.q)}%`)
  if (filter?.stuck) {
    const cutoff = new Date(nowMs - STALE_DAYS * DAY_MS).toISOString()
    // The cutoff date is compared as dealAge compares it (a plain date, the
    // database's UTC session).
    out = out.or(
      `stage_entered_at.lte.${cutoff},and(stage_entered_at.is.null,created_at.lte.${cutoff},created_at.gte.${PIPELINE_BACKFILL_CUTOFF})`,
    )
  }
  return out
}
