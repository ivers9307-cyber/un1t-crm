// ROSTER-FIX.5 — nightly roster horizon.
//
// Before this, shift_blocks were only materialised when something asked for
// them: saving a template's days_of_week, or an operator scrolling the web
// calendar past the 8-week window (`/api/schedule/blocks` GET used to
// lazy-extend). Neither happens on its own, and neither happens at all on
// mobile — so a location whose manager hadn't opened the calendar in a while
// simply had no blocks in the coming weeks, and every roster surface read
// "empty" rather than "not generated yet".
//
// This module is the sweep behind `/api/cron/extend-roster-horizon`: for every
// active template, keep `weeks` weeks of blocks in front of this week's Monday.
// Generation is idempotent (unique key on location+template+date), so running
// it nightly costs one upsert per template and inserts only what is missing.
//
// Pure on its inputs (db passed in) so it unit-tests with the standard mock.

import { generateBlocksForTemplate, getMonday } from '@/lib/roster'
import { readBlocksForFill, fillUsualCoaches, normaliseUsualCoachIds } from '@/lib/shift-usual-coaches'
import { logInfo, logWarn } from '@/lib/log'

/**
 * Extend the block horizon for every active shift template.
 *
 * @param {SupabaseClient} db   server-role client
 * @param {object} [opts]
 * @param {number} [opts.weeks=8]  weeks to keep materialised from this Monday
 * USUALCOACH.1 — a template's usual coaches go onto the blocks THIS run
 * created (never a block that already existed: a manager may have emptied it
 * on purpose), through fillUsualCoaches, which skips leave, cannot-work days,
 * clashes and anyone no longer at the studio. A failed fill never fails the
 * sweep: the shifts exist, a manager can still staff them.
 *
 * @returns {Promise<{ templates: number, inserted: number, skipped: number, removed: number, failed: number,
 *   usualAssigned: number, usualSkipped: number, usualFillFailed: number }>}
 *   `removed` — dates not generated because a manager deleted that slot
 *   (SLOTREMOVAL.1; the generator reads shift_block_removals once per template).
 * @throws when the template query itself fails — the cron must NOT stamp a
 *         heartbeat for a run that never saw the templates.
 */
export async function extendRosterHorizon(db, { weeks = 8 } = {}) {
  const { data, error } = await db
    .from('shift_templates')
    .select('id, location_id, start_time, end_time, days_of_week, min_coaches, max_coaches, usual_coach_ids')
    .eq('active', true)

  if (error) throw new Error(`Failed to load shift templates: ${error.message}`)

  // A template with no weekdays generates nothing. Filtering in JS rather
  // than with a `days_of_week <> '{}'` filter keeps us off PostgREST's
  // array-literal quirks — there are tens of templates, not thousands.
  const templates = (data || []).filter(t => (t.days_of_week || []).length > 0)

  const from = getMonday(new Date())
  let inserted = 0
  let skipped = 0
  let failed = 0
  let removed = 0
  let usualAssigned = 0
  let usualSkipped = 0
  let usualFillFailed = 0

  for (const template of templates) {
    let res
    try {
      res = await generateBlocksForTemplate(db, template, from, weeks)
      inserted += res.inserted
      skipped += res.skipped
      removed += res.removed || 0
    } catch (err) {
      // One malformed template must not leave every other location without a
      // horizon for the night.
      failed += 1
      logWarn('roster-horizon', 'template generation failed', {
        templateId: template.id, locationId: template.location_id, err,
      })
      continue
    }

    const newIds = res?.insertedIds || []
    if (newIds.length === 0 || normaliseUsualCoachIds(template.usual_coach_ids).length === 0) continue
    try {
      const { blocks, error } = await readBlocksForFill(db, { blockIds: newIds })
      if (error) throw new Error(error.message)
      const fill = await fillUsualCoaches(db, blocks, { actorId: null })
      usualAssigned += fill.assigned.length
      usualSkipped += fill.skipped.length
      if (fill.skipped.length > 0) {
        // Counts by reason only: no names in logs.
        logInfo('roster-horizon', 'usual coaches skipped on new shifts', {
          templateId: template.id, locationId: template.location_id, counts: fill.counts,
        })
      }
    } catch (err) {
      usualFillFailed += 1
      logWarn('roster-horizon', 'usual coach fill failed; shifts left empty', {
        templateId: template.id, locationId: template.location_id, err: err?.message || String(err),
      })
    }
  }

  return { templates: templates.length, inserted, skipped, removed, failed, usualAssigned, usualSkipped, usualFillFailed }
}
