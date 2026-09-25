// SHIFTTPL.1 — the block-side effects of editing a shift template, in one
// place because TWO routes perform them and they had already drifted.
//
// `PUT /api/schedule/templates/[id]` with `active:false` cleared the empty
// future blocks (keeping the published ones) and skipped regeneration.
// `DELETE /api/schedule/templates/[id]` — which is what the web Deactivate
// button actually calls — set `active:false` and did nothing else, so the
// same operator action left the calendar full of slots for a shift that no
// longer exists, depending only on which surface they used. The mobile app
// and the API's own PUT cleaned up; the web button did not.

import { liveAssignments } from './roster'

// PostgREST caps every select at 1,000 rows whatever it asks for (CLAUDE.md).
const FUTURE_BLOCK_PAGE_SIZE = 1000

/**
 * The future blocks for a template, with everything the deactivate decision
 * needs: whether each is on a published roster and whether anyone is on it.
 *
 * ROSTERTIDY.1 — PAGED. This used to rest on a bound: one template over the
 * 8-week generation horizon is at most 56 rows, so the 1,000-row cap looked
 * unreachable. But the same read feeds the template-minimum propagation, and a
 * bound that lives in another file (generateBlocksForTemplate's horizon) is
 * one nobody re-checks when it changes — past the cap this would silently
 * clamp, or clear, only the first 1,000 blocks. Paged on (block_date, id).
 * Mig 067's unique key already makes block_date unique within one template at
 * one location; the id tiebreak is there so page boundaries stay stable even
 * if that key is ever relaxed.
 *
 * A page that fails returns the error and NO blocks, never the pages read so
 * far — a partial list here reads as "these are all the future blocks", which
 * is exactly the silent skip paging exists to prevent.
 *
 * @returns {Promise<{ blocks: Array<object>, error: any }>}
 */
export async function readFutureBlocksForTemplate(db, { templateId, locationId, today }) {
  const blocks = []
  for (let from = 0; ; from += FUTURE_BLOCK_PAGE_SIZE) {
    const { data: page, error } = await db
      .from('shift_blocks')
      .select('id, block_date, start_time, end_time, min_coaches, max_coaches, roster_id, rosters:roster_id(status), shift_assignments(profile_id, status)')
      .eq('template_id', templateId)
      .eq('location_id', locationId)
      .gte('block_date', today)
      .order('block_date', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + FUTURE_BLOCK_PAGE_SIZE - 1)
    if (error) return { blocks: [], error }
    blocks.push(...(page || []))
    if (!page || page.length < FUTURE_BLOCK_PAGE_SIZE) break
  }
  return { blocks, error: null }
}

/**
 * ROSTER-FIX.4's deactivate clean-up, callable from either route.
 *
 * Deletes the future blocks that are BOTH empty of live assignments AND not
 * on a published roster. A block with a live coach on it is left alone —
 * deactivating a template must never silently cancel somebody's shift — and
 * so is an empty PUBLISHED block: it is part of a week staff have already
 * been shown, and this path writes no roster_change_log row, so deleting it
 * would make a published slot disappear with nothing recording that it ever
 * existed. `publishedEmptiesKept` is reported so the operator learns why the
 * calendar did not go empty.
 *
 * @param {Array<object>|null} blocks  already-read future blocks; read here when omitted
 * @returns {Promise<{ deleted: number, publishedEmptiesKept: number, error: any }>}
 */
export async function clearEmptyFutureBlocks(db, { templateId, locationId, today, blocks = null }) {
  let futureBlocks = blocks
  if (!futureBlocks) {
    const read = await readFutureBlocksForTemplate(db, { templateId, locationId, today })
    // A failed read must not read as "nothing to clear" — that is the silent
    // no-op this helper exists to remove.
    if (read.error) return { deleted: 0, publishedEmptiesKept: 0, error: read.error }
    futureBlocks = read.blocks
  }

  const allEmpties = futureBlocks.filter((b) => liveAssignments(b.shift_assignments).length === 0)
  const empties = allEmpties.filter((b) => b.rosters?.status !== 'published')
  const publishedEmptiesKept = allEmpties.length - empties.length
  if (empties.length === 0) return { deleted: 0, publishedEmptiesKept, error: null }

  const { error } = await db
    .from('shift_blocks')
    .delete()
    .in('id', empties.map((b) => b.id))
    .eq('location_id', locationId)
  if (error) return { deleted: 0, publishedEmptiesKept, error }
  return { deleted: empties.length, publishedEmptiesKept, error: null }
}

/**
 * SHIFTMIN-CLAMP.1 — the future-block writes for a capacity edit, grouped so
 * that no single statement can violate `shift_blocks_min_coaches_check`
 * (`min_coaches >= 0 AND min_coaches <= max_coaches`, mig 177).
 *
 * THE BUG: saving a template's minimum pushed that one number onto EVERY
 * future block in one UPDATE. A block whose `max_coaches` a manager had cut
 * below the new minimum fails the CHECK, and a failing statement fails for
 * all of them — so the propagation landed on nothing, while the template row
 * itself had already saved. The operator saw a saved template, a warning they
 * had no way to act on, and a calendar that still flagged the old minimum.
 * Mig 611 hit exactly this and solved it with `LEAST(min, b.max_coaches)`;
 * the route never learned the same lesson.
 *
 * Clamping per block is the same answer: a block can never require more
 * coaches than it has room for, so the floor it gets is the template's
 * minimum or its own ceiling, whichever is lower. Lowering `max_coaches`
 * alone can break the same CHECK from the other side (a block sitting at
 * min 3 when max drops to 2), so that case is clamped here too.
 *
 * Returns one group per distinct patch, each with the block ids it applies
 * to. A block whose values would not change is not written at all.
 *
 * @param {Array<{id: string, min_coaches?: number, max_coaches?: number}>} blocks
 * BLOCKEDIT.1 second review 2 — `followMin` / `followMax` are the template's
 * OLD values. When given, a field reaches only blocks still AT that value: a
 * block whose own minimum/maximum was edited (PUT /api/schedule/blocks/[id])
 * keeps it. Per field, so a block with its own maximum still takes a new
 * template minimum (clamped to its own ceiling). A block edited to a value
 * that happens to equal the template's old one cannot be told apart from an
 * unedited block and is treated as unedited. Omit `followMin` to force the
 * minimum everywhere (a switch to admin: an admin shift has no minimum).
 *
 * @param {{ minCoaches?: number|null, maxCoaches?: number|null, followMin?: number, followMax?: number }} edit
 *        min/max null/undefined = not being edited
 * @returns {Array<{ patch: {min_coaches?: number, max_coaches?: number}, expect: {min_coaches, max_coaches}, ids: string[] }>}
 *          `expect` = the values the group's blocks were read with (guard the write on them)
 */
export function planBlockCapacityUpdates(blocks, { minCoaches: minEdit = null, maxCoaches: maxEdit = null, followMin, followMax } = {}) {
  if (minEdit == null && maxEdit == null) return []
  const groups = new Map()
  for (const b of blocks || []) {
    const currentMax = Number(b.max_coaches)
    const currentMin = Number(b.min_coaches)
    const minCoaches = minEdit != null && (followMin === undefined || currentMin === Number(followMin)) ? minEdit : null
    const maxCoaches = maxEdit != null && (followMax === undefined || currentMax === Number(followMax)) ? maxEdit : null
    const nextMax = maxCoaches == null ? currentMax : maxCoaches
    // An unreadable max cannot be clamped against, so leave the block's own
    // ceiling out of the sum rather than inventing one.
    const ceiling = Number.isFinite(nextMax) ? nextMax : Infinity
    const desiredMin = minCoaches == null ? currentMin : minCoaches
    const nextMin = Number.isFinite(desiredMin) ? Math.min(desiredMin, ceiling) : desiredMin

    const patch = {}
    if (maxCoaches != null && nextMax !== currentMax) patch.max_coaches = nextMax
    if (Number.isFinite(nextMin) && nextMin !== currentMin) patch.min_coaches = nextMin
    if (Object.keys(patch).length === 0) continue

    // BLOCKEDIT.1 third check — the values this block was READ with. The
    // caller guards the write on them, so a block a manager edited between
    // the read and the write is left alone; blocks read differently never
    // share a statement.
    const expect = { min_coaches: b.min_coaches, max_coaches: b.max_coaches }
    const key = JSON.stringify([patch, expect])
    if (!groups.has(key)) groups.set(key, { patch, expect, ids: [] })
    groups.get(key).ids.push(b.id)
  }
  return [...groups.values()]
}
