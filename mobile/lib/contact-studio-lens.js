// CARDLENS-M.8 — the contact screen's studio lens: the studio the screen's
// buttons act at (WhatsApp, email, notes, tasks), chosen like the web contact
// page's ActingStudioBar. The server picks and judges it
// (GET /api/contacts/[id]/command-centre?scope=drawer&studio=…, see
// src/lib/contact-phone-extras.js phoneActingLens); this only reads its answer.
// Pure: no react-native imports, so the repo's vitest collects the test.
//
// A bundle from a server older than M-B has no `lens`: no switcher, and the
// screen sends no location_id, so every route acts at the primary as before.
import { studioTag } from './contact-platform-cards'

export const ALL_STUDIOS = 'all'
export const DEFAULT_STUDIO = 'default'

const PLATFORM_WORDS = Object.freeze({ glofox: 'Glofox', un1t_online: 'un1t.online' })

/**
 * @param {object|string|null} bundle the drawer bundle, or 'loading' / 'error'
 * @returns {{
 *   hasLens: boolean,
 *   options: Array<{ id: string, label: string, platform: string|null, primary: boolean }>,
 *   showSwitcher: boolean,
 *   actingId: string|null,
 *   actingLabel: string|null,
 *   isAll: boolean,
 *   sendLocationId: string|null,
 *   footer: string|null,
 * }}
 */
export function lensView(bundle) {
  const none = {
    hasLens: false, options: [], showSwitcher: false, actingId: null, actingLabel: null,
    isAll: false, sendLocationId: null, footer: null,
  }
  if (!bundle || typeof bundle !== 'object' || !Array.isArray(bundle.studio_options)) return none
  if (bundle.lens !== 'studio' && bundle.lens !== 'all') return none
  const label = (id, name) => studioTag(bundle, id) || name || 'Studio'
  const options = bundle.studio_options
    .filter((o) => o && typeof o.location_id === 'string')
    .map((o) => ({ id: o.location_id, label: label(o.location_id, o.name), platform: o.platform || null, primary: o.primary === true }))
  const isAll = bundle.lens === 'all'
  const actingId = isAll ? null : (bundle.acting_studio?.location_id || null)
  const actingLabel = actingId ? label(actingId, bundle.acting_studio?.name) : null
  // A person at one studio has no tags (studio_tags is {}): no footer, the
  // screen reads exactly as it did.
  const multiStudio = Boolean(bundle.studio_tags && Object.keys(bundle.studio_tags).length > 1)
  return {
    hasLens: true,
    options,
    showSwitcher: options.length >= 2,
    actingId,
    actingLabel,
    isAll,
    sendLocationId: actingId,
    footer: isAll
      ? 'Choose a studio to message, add a note or a task.'
      : (multiStudio && actingLabel ? `Sends from the ${actingLabel} number. Notes and tasks file at ${actingLabel}.` : null),
  }
}

/** The words for a platform chip, or null. */
export function platformWord(platform) {
  return PLATFORM_WORDS[platform] || null
}
