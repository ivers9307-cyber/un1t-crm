// CARDLENS-M.2 / M.3 — what the staff phone's contact screen needs beyond the
// drawer bundle: whether to show the Glofox card (and which studio it is), and
// the short studio names it tags threads, bookings and the timeline with.
//
// The phone keeps no studio or platform logic of its own (ROLEUI.1): the
// server decides here and the screen renders. Never throws: a failed read
// answers what the screen showed before CARDLENS-M (the Glofox card as it was,
// no tags), never "no studios".
import { loadContactStudios } from './contact-studios-display.js'
import { membershipSourceState } from './membership/source.js'
import { glofoxCardMode } from './contact-platforms.js'
import { studioTagNames } from '@shared/contact-studio-labels'

/**
 * Pure shaper.
 * @param {{ contact: object, studioRows: object[], primarySource: string|null }} a
 *   primarySource: the primary studio's membership_source, null when unreadable
 * @returns {{ glofox_card: { mode: 'linked'|'pushable'|'hidden', studio_name: string|null },
 *   studio_tags: Record<string, string> }}
 */
export function shapePhoneContactExtras({ contact, studioRows, primarySource }) {
  const rows = Array.isArray(studioRows) ? studioRows : []
  const mode = glofoxCardMode({ contact, primarySource })
  // The studio whose Glofox the card shows: the person's studio that runs
  // Glofox (one per organisation today), else the primary when it does.
  const glofoxRow = rows.find((r) => r?.location?.membership_source === 'glofox')
  const studioName = mode === 'hidden'
    ? null
    : (glofoxRow?.location?.name || (primarySource === 'glofox'
      ? (rows.find((r) => r?.location_id === contact?.location_id)?.location?.name || null)
      : null))
  return {
    glofox_card: { mode, studio_name: studioName },
    studio_tags: studioTagNames(rows),
  }
}

/**
 * @returns {Promise<ReturnType<typeof shapePhoneContactExtras>>}
 */
export async function loadPhoneContactExtras(db, contact) {
  const [studios, source] = await Promise.all([
    loadContactStudios(db, contact?.id, { primaryLocationId: contact?.location_id }).catch(() => ({ rows: [] })),
    membershipSourceState(db, contact?.location_id).catch(() => null),
  ])
  const primarySource = !source || source.state === 'unknown' ? null : (source.source ?? null)
  return shapePhoneContactExtras({ contact, studioRows: studios?.rows || [], primarySource })
}
