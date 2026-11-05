// MIASETTINGS.2a — the sections of the Mia settings page: which section a
// settings path lives in (the unsaved-change dots and the save bar's holds).
// MIASETTINGS.2c — the section list, and the section link in the URL
// (`?section=<key>`, `?scope=org`).

import { AGENT_FIELDS, SECTION_KEYS } from './fields'

const LABELS = {
  overview: 'Overview',
  personality: 'Personality and voice',
  handoffs: 'Handoffs',
  bookings: 'Bookings and sales',
  messages: 'Messages',
  followups: 'Follow-ups',
  cancellation: 'Cancellation form',
  knowledge: 'Knowledge',
  'member-app': 'Member app',
}
// The sections the organisation scope has (MIAORG: the org layer holds no
// bookings, cancellation form, knowledge or member app settings).
const ORG_SECTIONS = new Set(['overview', 'personality', 'handoffs', 'messages', 'followups'])

/** The page's sections, in menu order: { key, label, scopes }. */
export const SECTIONS = Object.freeze(SECTION_KEYS.map((key) => Object.freeze({
  key,
  label: LABELS[key],
  scopes: Object.freeze(ORG_SECTIONS.has(key) ? ['studio', 'org'] : ['studio']),
})))

/**
 * The section and scope a query string asks for, made safe: an unknown or
 * missing section is Overview; `scope=org` without org rights is the studio
 * scope; a section the scope does not have is Overview (Review Focus 5: a
 * deep link never shows a blank panel).
 * @param {string} search  location.search, with or without the '?'
 * @param {{ canOrg?: boolean }} opts
 * @returns {{ section: string, scope: 'studio'|'org' }}
 */
export function parseLocation(search, { canOrg = false } = {}) {
  const q = new URLSearchParams(search || '')
  const scope = canOrg && q.get('scope') === 'org' ? 'org' : 'studio'
  const asked = SECTIONS.find((s) => s.key === q.get('section'))
  return { section: asked && asked.scopes.includes(scope) ? asked.key : 'overview', scope }
}

/**
 * Put the section and scope in the address bar without a history entry,
 * leaving out the defaults (Overview, the studio scope) and keeping any other
 * query parameter.
 * @param {{ section: string, scope: 'studio'|'org' }} loc
 */
export function writeLocation({ section, scope }) {
  if (typeof window === 'undefined') return
  const q = new URLSearchParams(window.location.search)
  q.delete('section')
  q.delete('scope')
  if (section && section !== 'overview') q.set('section', section)
  if (scope === 'org') q.set('scope', 'org')
  const query = q.toString()
  window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`)
}

// Every registry settings path and the section it lives in.
const PATH_SECTIONS = AGENT_FIELDS.flatMap((f) => f.paths.map((p) => [p, f.section]))

/**
 * The section a settings path belongs to, from the field registry: the
 * longest registry path that equals `path` or is a prefix of it at a dot
 * boundary ('cancellation_form.reason_labels.price' → cancellation,
 * 'quiet_hours.start' → overview). A whole object key whose registry fields
 * all sit in one section ('followups') maps there. Null when nothing matches.
 * @param {string} path
 * @returns {string|null} one of SECTION_KEYS, or null
 */
export function sectionForPath(path) {
  let best = null
  for (const [p, section] of PATH_SECTIONS) {
    if ((path === p || path.startsWith(`${p}.`)) && (!best || p.length > best.p.length)) best = { p, section }
  }
  if (best) return best.section
  const under = new Set(PATH_SECTIONS.filter(([p]) => p.startsWith(`${path}.`)).map(([, s]) => s))
  return under.size === 1 ? [...under][0] : null
}
