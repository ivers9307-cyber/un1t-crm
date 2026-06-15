// name-utils — split a single full-name string into first/last.
//
// Public signup forms (race/event registration) collect a single
// "name" field. The rest of the CRM — the contact edit form, the
// "Create in Glofox" gate, Glofox /2.0/register — needs first_name +
// last_name. Mirror what /api/contacts already does so every
// contact-creation path produces the same shape.

/**
 * Split a full name into { firstName, lastName }.
 * - First whitespace-delimited token → firstName.
 * - Everything after → lastName (re-joined with single spaces).
 * - Single-token names → lastName null (we don't fabricate one).
 * - Empty / non-string input → both null.
 *
 * @param {string|null|undefined} full
 * @returns {{ firstName: string|null, lastName: string|null }}
 */
export function splitName(full) {
  if (!full || typeof full !== 'string') return { firstName: null, lastName: null }
  const parts = full.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { firstName: null, lastName: null }
  return {
    firstName: parts[0],
    lastName: parts.length > 1 ? parts.slice(1).join(' ') : null,
  }
}
