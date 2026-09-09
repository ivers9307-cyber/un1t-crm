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
import { logWarn } from '@/lib/log'

/**
 * Extend the block horizon for every active shift template.
 *
 * @param {SupabaseClient} db   server-role client
 * @param {object} [opts]
 * @param {number} [opts.weeks=8]  weeks to keep materialised from this Monday
 * @returns {Promise<{ templates: number, inserted: number, skipped: number, failed: number }>}
 * @throws when the template query itself fails — the cron must NOT stamp a
 *         heartbeat for a run that never saw the templates.
 */
export async function extendRosterHorizon(db, { weeks = 8 } = {}) {
  const { data, error } = await db
    .from('shift_templates')
    .select('id, location_id, start_time, end_time, days_of_week, max_coaches')
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

  for (const template of templates) {
    try {
      const res = await generateBlocksForTemplate(db, template, from, weeks)
      inserted += res.inserted
      skipped += res.skipped
    } catch (err) {
      // One malformed template must not leave every other location without a
      // horizon for the night.
      failed += 1
      logWarn('roster-horizon', 'template generation failed', {
        templateId: template.id, locationId: template.location_id, err,
      })
    }
  }

  return { templates: templates.length, inserted, skipped, failed }
}
