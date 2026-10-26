// HATCHCOLD.2 — Cold at a studio that is not the contact's home studio.
//
// contacts.pipeline_dismissed_at is the HOME studio's Cold. A person shared
// across the organisation can sit on another studio's board (Hatch Street's
// Acquisition board holds Stillorgan-home contacts), and that board ignores
// the home studio's judgement, so Cold pressed there lands here instead:
// contact_pipeline_dismissals (mig 777), one row per (contact, studio).
//
// Readers ask dismissalAtStudio(): the home studio reads the contacts column,
// any other studio reads its own row. Service role only.

const TABLE = 'contact_pipeline_dismissals'

/**
 * The Cold stamp that applies on `locationId`'s board.
 * @param {{ location_id?: string|null, pipeline_dismissed_at?: string|null }|null} contact
 * @param {string} locationId
 * @param {string|null|undefined} studioDismissedAt this studio's row, if any
 */
export function dismissalAtStudio(contact, locationId, studioDismissedAt) {
  if (!contact || !locationId) return null
  if (contact.location_id != null && contact.location_id === locationId) {
    return contact.pipeline_dismissed_at ?? null
  }
  return studioDismissedAt ?? null
}

/**
 * Set (dismissedAt) or clear (null) Cold for a contact at a non-home studio.
 * @returns {Promise<{ error: object|null }>}
 */
export async function writeStudioDismissal(db, { contactId, locationId, dismissedAt, userId = null }) {
  if (dismissedAt) {
    const { error } = await db
      .from(TABLE)
      .upsert(
        { contact_id: contactId, location_id: locationId, dismissed_at: dismissedAt, dismissed_by: userId },
        { onConflict: 'contact_id,location_id' },
      )
    return { error: error ?? null }
  }
  const { error } = await db
    .from(TABLE)
    .delete()
    .eq('contact_id', contactId)
    .eq('location_id', locationId)
  return { error: error ?? null }
}

/**
 * One contact's Cold stamp at one non-home studio.
 * @returns {Promise<{ dismissedAt: string|null, error: object|null }>}
 */
export async function readStudioDismissal(db, contactId, locationId) {
  const { data, error } = await db
    .from(TABLE)
    .select('dismissed_at')
    .eq('contact_id', contactId)
    .eq('location_id', locationId)
    .maybeSingle()
  if (error) return { dismissedAt: null, error }
  return { dismissedAt: data?.dismissed_at ?? null, error: null }
}

/**
 * The Cold stamp for `contact` on `locationId`'s board, reading this studio's
 * row only when the contact's home is elsewhere.
 * @param {{ id: string, location_id?: string|null, pipeline_dismissed_at?: string|null }} contact
 * @returns {Promise<{ dismissedAt: string|null, error: object|null }>}
 */
export async function resolveStudioDismissal(db, contact, locationId) {
  if (!contact?.location_id || contact.location_id === locationId || !contact.id) {
    return { dismissedAt: contact?.pipeline_dismissed_at ?? null, error: null }
  }
  return readStudioDismissal(db, contact.id, locationId)
}
