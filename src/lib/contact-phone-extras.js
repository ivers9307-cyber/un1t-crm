// CARDLENS-M.2 / M.3 / M.4 — what the staff phone's contact screen needs
// beyond the drawer bundle: whether to show the Glofox card (and which studio
// it is), the short studio names it tags threads, bookings and the timeline
// with, and whether a note posted here also lands in Glofox.
//
// The phone keeps no studio or platform logic of its own (ROLEUI.1): the
// server decides here and the screen renders. Never throws: a failed read
// answers what the screen showed before CARDLENS-M (the Glofox card as it was,
// no tags), never "no studios".
import { loadContactStudios } from './contact-studios-display.js'
import { membershipSourceState } from './membership/source.js'
import { glofoxCardMode } from './contact-platforms.js'
import { studioTagNames } from '@shared/contact-studio-labels'
import { actingStudioOptions, pickActingStudio } from './contact-acting-studio.js'

/**
 * Pure shaper.
 * @param {{ contact: object, studioRows: object[], primarySource: string|null }} a
 *   primarySource: the primary studio's membership_source, null when unreadable
 * @returns {{ glofox_card: { mode: 'linked'|'pushable'|'hidden', studio_name: string|null },
 *   studio_tags: Record<string, string>, glofox_note_push: boolean }}
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
    // POST /api/contacts/[id]/notes copies the note into Glofox with the
    // PRIMARY studio's Glofox credentials (src/lib/glofox-note-push.js), so
    // it lands only when the person has a Glofox account AND the primary
    // studio runs Glofox. A Hatch-primary person with a Stillorgan Glofox id
    // gets no push, and the composer must not say they do. An unreadable
    // source keeps the old hint (any linked contact).
    glofox_note_push: Boolean(contact?.glofox_member_id) && (primarySource === 'glofox' || primarySource == null),
  }
}

/**
 * CARDLENS-M.6 — the studio the phone's contact screen acts at, the web
 * page's rule (src/lib/contact-acting-studio.js).
 *   requested null      a phone older than M-B: no lens, the primary studio
 *                       judges everything exactly as before
 *   'default'           the web page's default: the viewer's active studio,
 *                       else the primary, else the first shared studio
 *   'all'               All studios: view only, acts nowhere
 *   a location id       that studio when it is an option, else the default
 * A viewer who shares no studio with the person acts at the primary, which
 * judges them as before (every flag off).
 *
 * @returns {{ lens: 'legacy'|'studio'|'all', actingId: string|null,
 *   options: Array<{ locationId: string, name: string, source: string|null, primary: boolean }> }}
 */
export function phoneActingLens({ user, contact, studioRows, requested }) {
  const primaryId = contact?.location_id || null
  const options = actingStudioOptions({ user, contact, studioRows })
  if (requested == null || requested === '') return { lens: 'legacy', actingId: primaryId, options }
  if (requested === 'all') return { lens: 'all', actingId: null, options }
  const actingId = pickActingStudio({
    options,
    requested: requested === 'default' ? null : requested,
    activeLocationId: user?.activeLocation?.id || null,
    primaryLocationId: primaryId,
  }) || primaryId
  return { lens: 'studio', actingId, options }
}

/**
 * @returns {Promise<ReturnType<typeof shapePhoneContactExtras> & { studioRows: object[] }>}
 *   studioRows is for the route's own use (the acting lens); never send it on
 */
export async function loadPhoneContactExtras(db, contact) {
  const [studios, source] = await Promise.all([
    loadContactStudios(db, contact?.id, { primaryLocationId: contact?.location_id }).catch(() => ({ rows: [] })),
    membershipSourceState(db, contact?.location_id).catch(() => null),
  ])
  const primarySource = !source || source.state === 'unknown' ? null : (source.source ?? null)
  const studioRows = studios?.rows || []
  return { ...shapePhoneContactExtras({ contact, studioRows, primarySource }), studioRows }
}
