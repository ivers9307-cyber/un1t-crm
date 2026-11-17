// CONTACTTAGS.1 — the manual tags on a contact (contacts.tags, a text[]),
// shared by the profile Tags card, the contacts list's bulk Add / Remove tag
// and POST /api/contacts/bulk-tags. Pure: no I/O.
//
// Two tag stores exist and this module is about ONE of them:
//   • contacts.tags — free-text tags staff type. Written only through
//     PUT /api/contacts/[id] (a single contact) and POST /api/contacts/bulk-tags.
//   • contact_tags — machine-derived tags (mig 085, src/lib/contact-tags.js),
//     shown read-only on the profile. Nothing here writes them.
//
// The rules match PUT /api/contacts/[id]'s schema (each tag 1..64 characters,
// at most 50 on a contact) so a tag added here can always be saved again by
// the edit form, and the edit form's own split (trim, drop empties) is the
// normalisation: case is kept, because existing tags are case-sensitive in
// tag_added sequence triggers and audience filters.
// Client-safe: no imports (the profile card and the bulk dialog use it). The
// bulk gate lives in contact-bulk-tag-gate.js.

export const TAG_MAX_LENGTH = 64
export const MAX_TAGS_PER_CONTACT = 50

/** Trim and collapse inner whitespace. '' for anything unusable. */
export function normaliseManualTag(raw) {
  if (typeof raw !== 'string') return ''
  return raw.replace(/\s+/g, ' ').trim()
}

/** null when the tag is acceptable, else a sentence for the operator. */
export function manualTagProblem(tag) {
  if (!tag) return 'Type a tag first.'
  if (tag.length > TAG_MAX_LENGTH) return `Tags can be at most ${TAG_MAX_LENGTH} characters.`
  return null
}

/**
 * The tags after adding or removing one.
 * @param {string[]|null|undefined} current
 * @param {string} tag   already normalised
 * @param {'add'|'remove'} action
 * @returns {{ changed: boolean, next: string[], tooMany?: boolean }}
 */
export function applyManualTagChange(current, tag, action) {
  const list = Array.isArray(current) ? current.filter((t) => typeof t === 'string') : []
  if (action === 'add') {
    if (list.includes(tag)) return { changed: false, next: list }
    if (list.length >= MAX_TAGS_PER_CONTACT) return { changed: false, next: list, tooMany: true }
    return { changed: true, next: [...list, tag] }
  }
  if (action === 'remove') {
    if (!list.includes(tag)) return { changed: false, next: list }
    return { changed: true, next: list.filter((t) => t !== tag) }
  }
  return { changed: false, next: list }
}

/**
 * A Postgres array literal for a text[] equality filter (PostgREST
 * `tags=eq.{…}`). Every element is double-quoted with `\` and `"` escaped,
 * so a tag holding a comma, brace or quote cannot change the array's shape.
 */
export function textArrayLiteral(list) {
  const items = (list || []).map((t) => `"${String(t).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
  return `{${items.join(',')}}`
}

/**
 * The profile's read-only machine tags: active contact_tags rows, one chip per
 * tag (the newest row wins), only rows the viewer may see (`visible(row)`:
 * the page passes "no studio, or a studio where the viewer holds Contacts"),
 * each with a short description for its title.
 * @param {Array<{ tag: string, location_id?: string|null, added_at?: string|null }>} rows
 * @param {{ visible?: (row: object) => boolean, describe?: (tag: string) => string }} [opts]
 * @returns {Array<{ tag: string, addedAt: string|null, description: string }>}
 */
export function machineTagChips(rows, { visible = () => true, describe = () => '' } = {}) {
  const byTag = new Map()
  for (const r of rows || []) {
    if (!r?.tag || !visible(r)) continue
    const prev = byTag.get(r.tag)
    if (!prev || String(r.added_at || '') > String(prev.addedAt || '')) {
      byTag.set(r.tag, { tag: r.tag, addedAt: r.added_at || null, description: describe(r.tag) || '' })
    }
  }
  return [...byTag.values()].sort((a, b) => a.tag.localeCompare(b.tag))
}
