// CARDLENS-M.2 / M.3 — what the contact screen draws for a person's studios
// and platforms, from the drawer bundle (GET /api/contacts/[id]/command-centre
// ?scope=drawer). The server decides (src/lib/contact-phone-extras.js); this
// only reads its answer. Pure: no react-native imports, so the repo's vitest
// collects the test.
//
// A bundle from a server older than this app (the OTA can land before the
// deploy) has no `glofox_card` / `studio_tags`: the screen then renders as it
// did before, the Glofox card included and no tags.
import { studioTagFor } from 'shared/contact-studio-labels'

export const GLOFOX_CARD_TITLE = 'Glofox membership'

/**
 * @param {'loading'|'error'|object} bundle the drawer bundle, or its state
 * @param {{ glofox_member_id?: string|null }|null} contact
 * @returns {{ show: boolean, linked: boolean, title: string, unlinkedHint: string }}
 */
export function glofoxCardView(bundle, contact) {
  const linkedRow = Boolean(contact?.glofox_member_id)
  const before = {
    show: true,
    linked: linkedRow,
    title: GLOFOX_CARD_TITLE,
    unlinkedHint: 'Not linked to Glofox yet. Link this contact from the web CRM.',
  }
  // Until the bundle lands nothing is drawn, so a un1t.online member's
  // screen never flashes a Glofox card; a failed bundle keeps the old card.
  if (bundle === 'loading') return { ...before, show: false }
  if (!bundle || typeof bundle !== 'object') return before
  const card = bundle.glofox_card
  if (!card || typeof card !== 'object') return before
  if (card.mode === 'hidden') return { ...before, show: false, linked: false }
  const name = typeof card.studio_name === 'string' && card.studio_name.trim() ? card.studio_name.trim() : null
  return {
    show: true,
    linked: card.mode === 'linked',
    title: name ? `Glofox · ${name}` : GLOFOX_CARD_TITLE,
    unlinkedHint: 'Not in Glofox yet. Add them from the web CRM.',
  }
}

/**
 * CARDLENS-M.4 — whether a note posted from the screen also lands in the
 * member's Glofox timeline (the composer's hint). The server knows: the push
 * uses the primary studio's Glofox, so a Hatch-primary person with a
 * Stillorgan Glofox id gets none. An older server: any linked contact, as
 * before.
 * @param {object|string|null} bundle
 * @param {{ glofox_member_id?: string|null }|null} contact
 */
export function notePostsToGlofox(bundle, contact) {
  if (bundle && typeof bundle === 'object' && typeof bundle.glofox_note_push === 'boolean') return bundle.glofox_note_push
  return Boolean(contact?.glofox_member_id)
}

/**
 * The studio tag for a row, or null (one studio, an old server, no location).
 * @param {object|null|undefined} bundle
 * @param {string|null|undefined} locationId
 */
export function studioTag(bundle, locationId) {
  const tags = bundle && typeof bundle === 'object' ? bundle.studio_tags : null
  return studioTagFor(tags && typeof tags === 'object' ? tags : null, locationId)
}

/**
 * CARDLENS-M.3 — the WhatsApp section's rows: the latest thread at each
 * studio (a person can hold one per studio number), newest first, at most
 * `max`. Rows arrive newest first; a row with no location counts as its own.
 * @param {Array<{ id: string, location_id?: string|null }>} rows
 * @param {number} [max]
 */
export function latestThreadPerStudio(rows, max = 3) {
  const seen = new Set()
  const out = []
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r?.id) continue
    const key = r.location_id || `row:${r.id}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(r)
    if (out.length >= max) break
  }
  return out
}
