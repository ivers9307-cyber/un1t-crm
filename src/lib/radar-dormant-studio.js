// ORGCONTACTS.4 (decision 3) — the radars' "archive" / "stale" decision, per
// studio: the person's contact_studios row AT the radar's studio takes
// stage_slug 'dormant' (its kind / source / status kept), for owned and
// crossover contacts alike. The contact-wide column (contacts.pipeline_stage_slug)
// is the route's own write and stays owned-only: it follows the primary
// studio's board. A person with no relationship row here is not marked here.
//
// Best effort, never throws: a failed read or write is logged and the
// decision still lands (the action log and the contacts column are the record).
// Note the nightly reconcile_contact_studios() re-derives stage_slug from the
// open deal at the studio, so a mark on a row whose deal sits in another stage
// is re-derived at the next reconcile, as the contact-wide column is by the
// classifier today.
import { contactsAtStudio, upsertContactStudio } from './contact-studios'
import { logWarn } from './log'

/**
 * @returns {Promise<{ marked: number, skipped: number, failed: number }>}
 */
export async function markDormantAtStudio(db, { locationId, contactIds, module = 'radar' }) {
  const ids = [...new Set((contactIds || []).filter(Boolean))]
  if (!locationId || ids.length === 0) return { marked: 0, skipped: 0, failed: 0 }
  const rows = await contactsAtStudio(db, locationId, { contactIds: ids })
  if (!rows.ok) {
    logWarn(module, 'studio rows unreadable; dormant not marked on contact_studios', { locationId, count: ids.length, error: rows.error })
    return { marked: 0, skipped: ids.length, failed: 0 }
  }
  let marked = 0
  let failed = 0
  for (const r of rows.rows) {
    const w = await upsertContactStudio(db, {
      contactId: r.contact_id, locationId, kind: r.kind, status: r.status, source: r.source, stageSlug: 'dormant',
    })
    if (w.ok) marked += 1
    else { failed += 1; logWarn(module, 'studio dormant write failed', { locationId, contactId: r.contact_id, error: w.error }) }
  }
  return { marked, skipped: ids.length - rows.rows.length, failed }
}
